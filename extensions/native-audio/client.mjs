// Independently installed Folium client: public settings, backend registration and JSON RPC only.

export default async function activate(folium) {
    if (folium.env.context !== 'main') return;
    // Carry the host's digest query to the helper so updating a mod also updates its imported code.
    const helper = new URL('./deviceSettings.mjs', import.meta.url);
    helper.search = new URL(import.meta.url).search;
    const { label, registerDeviceSettings } = await import(helper.href);
    const section = registerDeviceSettings(folium, {
        id: 'output', label: label('Native audio and DSP', '原生音频与 DSP'),
        description: label('Uses the bundled WASAPI/SoXR engine. Changes pause and reopen output. DSP is not bit-perfect; higher rates do not guarantee better sound.', '默认使用模组自带的 WASAPI/SoXR 引擎。改设置会暂停并重新打开设备。DSP 不保持 bit-perfect；更高采样率不保证更好听。'),
        settings: [
            { key: 'executable', type: 'text', label: label('Engine path (bundled = included engine)', '引擎路径（bundled = 模组自带）'), defaultValue: 'bundled' },
            { key: 'device', type: 'text', label: label('mpv audio device ID', 'mpv 音频设备 ID'), description: label('Use mpv --audio-device=help; auto selects the default endpoint.', '运行 mpv --audio-device=help 查询；auto 为默认设备。'), defaultValue: 'auto' },
            { key: 'exclusive', type: 'boolean', label: label('Strict WASAPI Exclusive', '强制 WASAPI 真独占'), description: label('Off by default. Failure stops playback; never falls back to shared output.', '默认关闭。独占失败停止播放，不回退共享模式。'), defaultValue: false },
            { key: 'outputFormat', type: 'select', label: label('Device sample container', '设备采样容器格式'), defaultValue: 'auto', options: [
                { value: 'auto', label: label('Device negotiation', '设备协商') },
                { value: 's32', label: label('32-bit integer container', '32 位整数容器') },
                { value: 'float', label: label('32-bit floating point', '32 位浮点') },
            ] },
            { key: 'dspEnabled', type: 'boolean', label: label('Enable DSP chain', '启用 DSP 处理链'), defaultValue: false },
            { key: 'resampleEnabled', type: 'boolean', label: label('Enable SoXR upsampling', '启用 SoXR 高质量升频'), description: label('Requires the DSP chain switch. When DSP is off, upsampling is bypassed.', '需要同时开启 DSP 处理链；DSP 总开关关闭时，升频处于旁路状态。'), defaultValue: false },
            { key: 'targetRate', type: 'select', label: label('Upsampling target', '升频目标采样率'), defaultValue: '192000', options: [88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000].map(rate => ({ value: String(rate), label: label(`${rate} Hz`, `${rate} Hz`) })) },
            { key: 'headroomEnabled', type: 'boolean', label: label('Enable headroom attenuation', '启用峰值余量衰减'), description: label('Fixed headroom reduces clipping risk, but cannot guarantee clipping-free audio. Bypass removes attenuation.', '固定余量降低削波风险，但不能保证绝不削波；旁路时不会衰减。'), defaultValue: true },
            { key: 'headroomDb', type: 'number', label: label('Headroom gain (dB)', '余量增益（dB）'), defaultValue: -3, min: -24, max: 0, step: 0.5 },
            { key: 'eqEnabled', type: 'boolean', label: label('Enable tone EQ', '启用音色 EQ'), defaultValue: false },
            { key: 'bassDb', type: 'number', label: label('Bass gain (dB)', '低频增益（dB）'), defaultValue: 0, min: -12, max: 12, step: 0.5 },
            { key: 'trebleDb', type: 'number', label: label('Treble gain (dB)', '高频增益（dB）'), defaultValue: 0, min: -12, max: 12, step: 0.5 },
            { key: 'order', type: 'text', label: label('DSP module order', 'DSP 模块顺序'), description: label('Comma-separated: headroom,resample,eq; each exactly once. Disabled modules are bypassed.', '用逗号排列 headroom,resample,eq，各出现一次；关闭的模块会旁路。'), defaultValue: 'headroom,resample,eq' },
        ],
    });

    let live = null;
    let pendingApply = Promise.resolve();
    folium.every(2000, () => {
        if (live) void folium.rpc.call('native.heartbeat').catch(error => folium.log.warn('Native audio heartbeat failed', error));
    });
    const registration = folium.experimental['playback.backends'].register({
        id: 'wasapi', name: 'Native Audio (mpv / WASAPI)',
        capabilities: { seek: true, volume: true, http: true },
        create(report) {
            let work = Promise.resolve();
            let stopped = false;
            let source = null;
            let position = 0;
            let configured = false;
            const call = (method, ...args) => folium.rpc.call(`native.${method}`, ...args);
            const enqueue = fn => {
                const operation = work.then(() => {
                    if (stopped) throw new Error('Native audio session retired');
                    return fn();
                });
                work = operation.catch(error => folium.log.warn('Native audio command failed', error));
                return operation;
            };
            const configure = async (values = section.settings.get()) => {
                configured = false;
                await call('configure', values);
                configured = true;
            };
            const off = folium.rpc.on('native.event', event => {
                if (!stopped) {
                    if (event.type === 'status') position = event.status.position;
                    report(event);
                }
            });
            const session = {
                open: next => enqueue(async () => {
                    if (!configured) await configure();
                    source = next;
                    position = 0;
                    await call('open', next);
                }),
                play: () => enqueue(() => call('play')),
                pause: () => enqueue(() => call('pause')),
                seek: seconds => enqueue(() => call('seek', seconds)),
                setVolume: volume => enqueue(() => call('setVolume', volume)),
                dispose: async () => {
                    stopped = true;
                    off();
                    if (live === session) live = null;
                    // Wait for older commands so disposal cannot be overtaken by a late open.
                    await work;
                    await call('dispose');
                },
                reconfigure: values => enqueue(async () => {
                    const resumeAt = position;
                    try {
                        await configure(values);
                        if (source) { await call('open', source); await call('seek', resumeAt); }
                    } catch (error) {
                        configured = false;
                        try { await call('dispose'); }
                        catch (cleanupError) { folium.log.error('Native audio failed-output cleanup failed', cleanupError); }
                        if (source) report({ type: 'error', sourceId: source.sourceId, message: error.message });
                        throw error;
                    }
                }),
            };
            live = session;
            return session;
        },
    });

    section.settings.onChange(() => {
        if (!live) { pendingApply = Promise.resolve(); return; }
        folium.playback.pause();
        pendingApply = live.reconfigure(section.settings.get());
        void pendingApply.catch(error => {
            folium.log.error('Native audio settings rejected; playback remains paused', error);
            folium.ui.toast(`设置未生效，播放已停止 / Settings could not be applied: ${error.message}`, { type: 'error' });
        });
    });
    for (const [id, key, en, zh] of [
        ['exclusive', 'exclusive', 'Toggle strict exclusive output', '切换真独占输出'],
        ['dsp', 'dspEnabled', 'Toggle native DSP chain', '切换原生 DSP 处理链'],
        ['upsampling', 'resampleEnabled', 'Toggle SoXR upsampling', '切换 SoXR 升频'],
    ]) {
        folium.registries.commands.register({
            id, label: label(en, zh), keywords: ['native audio', '原生音频'],
            description: label('Shows the new switch state. Output changes only when Native Audio is selected; changes leave playback paused.', '执行后显示开关状态。必须选择 Native Audio 后端才会改变输出；改设置后播放保持暂停。'),
            run: async () => {
                section.settings.set({ [key]: !section.settings.get()[key] });
                await pendingApply;
                const values = section.settings.get();
                const state = values[key] ? '开启 / ON' : '关闭 / OFF';
                let message = `${zh}: ${state}.`;
                if (!live) message += ' 设置已保存；请在播放控制中选择 Native Audio 后端 / Saved; select Native Audio in Playback settings.';
                else message += ' 配置已提交，播放保持暂停；按播放后检查实际输出状态 / Configured; press Play and check the reported output.';
                if (values.resampleEnabled && !values.dspEnabled) message += ' DSP 总开关关闭，SoXR 当前旁路 / DSP is off; SoXR is bypassed.';
                folium.ui.toast(message, { type: 'info' });
                return { message };
            },
        });
    }
    folium.registries.commands.register({
        id: 'refresh-devices', label: label('Refresh audio devices', '刷新音频设备'),
        keywords: ['wasapi device output', '音频设备 刷新 输出'],
        description: label('Refresh the selector after connecting a DAC or changing the engine. Does not change the selected device.', '连接 DAC 或更换引擎后刷新下拉列表，不会改变已选设备。'),
        run: () => section.refresh(),
    });
    folium.onDispose(() => registration.unregister());
}
