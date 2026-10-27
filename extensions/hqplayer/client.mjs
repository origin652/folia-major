// Public Folium backend adapter; all HQPlayer-specific transport remains in this independent mod.

export default async function activate(folium) {
    if (folium.env.context !== 'main') return;
    const helper = new URL('./settings.mjs', import.meta.url);
    helper.search = new URL(import.meta.url).search;
    const { registerSettings, fields, label, localized } = await import(helper.href);
    const clockHelper = new URL('./displayClock.mjs', import.meta.url);
    clockHelper.search = helper.search;
    const { createHqpDisplayClock } = await import(clockHelper.href);
    const section = registerSettings(folium);
    const backends = folium.experimental['playback.backends'];
    if (!backends?.register) throw new Error('This Folia build does not support playback.backends; use the modified host.');
    let live = null;
    let pendingApply = Promise.resolve();
    const call = (method, ...args) => folium.rpc.call(`hqplayer.${method}`, ...args);
    const dspHelper = new URL('./dspSettings.mjs', import.meta.url);
    dspHelper.search = helper.search;
    const { registerDspSettings } = await import(dspHelper.href);
    registerDspSettings(folium, section, call);
    folium.every(2000, () => {
        if (live) void call('heartbeat').catch(error => folium.log.warn('HQPlayer heartbeat failed', error));
    });
    const registration = backends.register({
        id: 'desktop', name: 'HQPlayer Desktop (local)',
        // HTTP/custom URLs are fetched by the host and staged without browser decoding.
        capabilities: { seek: true, volume: true, http: false },
        create(report) {
            let work = Promise.resolve();
            let stopped = false;
            let configured = false;
            let source = null;
            let position = 0;
            let clockNeedsReset = false;
            const clock = createHqpDisplayClock(report);
            const enqueue = action => {
                const result = work.then(() => {
                    if (stopped) throw new Error('HQPlayer session retired');
                    return action();
                });
                work = result.catch(error => folium.log.warn('HQPlayer operation failed', error));
                return result;
            };
            const off = folium.rpc.on('hqplayer.event', event => {
                if (stopped) return;
                if (event.type === 'status' && event.status.sourceId === source?.sourceId) position = event.status.position;
                if (event.type !== 'status' && event.sourceId === source?.sourceId) clockNeedsReset = true;
                clock.receive(event);
            });
            const configure = async values => { configured = false; await call('configure', values); configured = true; };
            const seek = async seconds => {
                clock.beginSeek(seconds);
                try { await call('seek', seconds); clock.finishSeek(); }
                catch (error) { clock.cancelSeek(); throw error; }
            };
            const session = {
                open: next => enqueue(async () => {
                    clock.setSource(next.sourceId);
                    clockNeedsReset = false;
                    if (!configured) await configure(section.settings.get());
                    source = next;
                    await call('open', next);
                }),
                play: () => enqueue(async () => {
                    if (clockNeedsReset && source) {
                        clock.setSource(source.sourceId);
                        clockNeedsReset = false;
                    }
                    await call('play');
                }),
                pause: () => enqueue(() => call('pause')),
                seek: seconds => enqueue(() => seek(seconds)),
                setVolume: volume => enqueue(() => call('setVolume', volume)),
                dispose: async () => {
                    stopped = true;
                    clock.setSource('');
                    off();
                    if (live === session) live = null;
                    await work;
                    await call('dispose');
                },
                reconfigure: values => enqueue(async () => {
                    const resumeAt = position;
                    clock.setSource(source?.sourceId ?? '');
                    clockNeedsReset = false;
                    await configure(values);
                    if (source) { await call('open', source); await seek(resumeAt); }
                }),
            };
            live = session;
            void enqueue(() => call('ensureRunning', section.settings.get())).catch(error => {
                if (!stopped) folium.ui.toast(error.message, { type: 'error' });
            });
            return session;
        },
    });
    section.settings.onChange(() => {
        if (!live) { pendingApply = Promise.resolve(); return; }
        folium.playback.pause();
        pendingApply = live.reconfigure(section.settings.get());
        void pendingApply.catch(error => {
            folium.log.error('HQPlayer settings could not be applied', error);
            folium.ui.toast(error.message, { type: 'error' });
        });
    });
    folium.registries.commands.register({
        id: 'check-connection', label: label('Check HQPlayer connection and license', '检查 HQPlayer 连接与注册状态', '檢查 HQPlayer 連線與註冊狀態', 'Periksa koneksi dan lisensi HQPlayer'),
        description: label('Read-only. Reports the running version, license status and output. Does not expose registration names or keys, or change playback.', '只读查询当前版本、授权和输出状态；不展示注册人、注册码，不改动播放。'),
        keywords: ['hqplayer connection license status', '连接 注册 授权 输出状态'],
        run: async () => {
            const info = await call('inspect', section.settings.get());
            const message = `${info.product} ${info.version} (engine ${info.engine}) · ${info.state}`
                + (info.licensed ? ' · Licensed / 已检测到有效注册' : ' · No valid license detected / 未检测到有效注册')
                + (info.variableVolume ? '' : ' · Enable variable volume in HQPlayer / 请在 HQPlayer 启用可变音量')
                + (info.sampleRate > 0 ? ` · ${info.mode} ${info.sampleRate} Hz / ${info.bits} bit · ${info.filter}` : '');
            folium.ui.toast(message, { type: 'info' });
            return { message };
        },
    });
    folium.registries.commands.register({
        id: 'configure', label: label('Configure HQPlayer connection', '配置 HQPlayer 连接', '設定 HQPlayer 連線', 'Atur koneksi HQPlayer'),
        description: label('Changes leave playback paused. Playlist takeover must be enabled separately in mod settings.', '修改后保持暂停；替换已有播放列表的权限需单独在模组设置开启。'),
        keywords: ['hqplayer settings port volume', '配置 端口 音量'], params: fields.filter(field => field.key !== 'takeOver'),
        run: async ({ values }) => {
            section.settings.set(values);
            await pendingApply;
            const message = localized(folium, label('Saved. Select HQPlayer Desktop in Playback settings, then press Play.', '已保存。请在播放设置选择 HQPlayer Desktop 后端，再按播放。', '已儲存。請在播放設定選擇 HQPlayer Desktop 後端，再按播放。', 'Disimpan. Pilih backend HQPlayer Desktop di pengaturan pemutaran, lalu tekan Putar.'));
            folium.ui.toast(message, { type: 'info' });
            return { message };
        },
    });
    folium.onDispose(() => registration.unregister());
}
