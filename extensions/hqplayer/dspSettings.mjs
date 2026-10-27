import { label, localized } from './settings.mjs';

// Dynamic host-rendered DSP drafts; only explicit commands send setters to HQPlayer.

const names = {
    filter: label('Oversampling filter (Nx)', '升频滤波器（Nx）', '升頻濾波器（Nx）', 'Filter oversampling (Nx)'),
    filter1x: label('Base-rate filter (1x)', '基础采样率滤波器（1x）', '基礎取樣率濾波器（1x）', 'Filter laju dasar (1x)'),
    shaper: label('Dither / noise shaper / modulator', '抖动 / 噪声整形 / 调制器', '抖動 / 雜訊整形 / 調變器', 'Dither / noise shaper / modulator'),
    rate: label('Output sample rate', '输出采样率', '輸出取樣率', 'Laju sampel keluaran'),
};
const select = (key, title, items, current) => ({
    key, type: 'select', label: title, defaultValue: String(current),
    options: items.map(item => ({ value: String(item.index), label: item.name === '[source]'
        ? label('Follow source / automatic', '跟随音源 / 自动', '跟隨音源 / 自動', 'Ikuti sumber / otomatis')
        : label(item.name, item.name) })),
});

export function registerDspSettings(folium, connection, call) {
    let snapshot = null;
    let handles = [];
    let busy = false;
    let disposed = false;
    let generation = 0;
    const clear = () => {
        generation++;
        snapshot = null;
        for (const handle of handles) handle.unregister();
        handles = [];
    };
    const message = text => {
        const value = localized(folium, text);
        folium.ui.toast(value, { type: 'info' });
        return { message: value };
    };
    const install = data => {
        clear();
        if (disposed) return;
        snapshot = data;
        const mode = data.modes.find(item => item.index === data.selection.mode).name;
        const schema = Object.keys(names).filter(key => key in data.selection).map(key => select(key, names[key],
            key === 'shaper' ? data.shapers : key === 'rate' ? data.rates : data.filters, data.selection[key]));
        const section = folium.registries.settingsSections.register({
            id: 'dsp', label: label(`HQPlayer DSP draft — ${mode}`, `HQPlayer DSP 草稿 — ${mode}`),
            description: label('Draft only. Use “Apply HQPlayer DSP draft” below to send changes. Applying stops Folia-owned output and keeps its position; press Play to resume. Mode changes have a separate command. Devices, CUDA and multicore stay in HQPlayer.',
                '此处仅编辑草稿；需执行下方“应用 HQPlayer DSP 草稿”才生效。应用会停止本模组的播放并保留进度，需手动按播放恢复。输出模式用单独命令切换；设备、CUDA、多核仍在 HQPlayer 设置。'),
            settings: schema,
        });
        // Discard persisted indices: they may belong to a different mode, device or HQPlayer version.
        section.settings.set(Object.fromEntries(schema.map(field => [field.key, field.defaultValue])));
        handles.push(section);
        const apply = async patch => {
            if (snapshot !== data) throw new Error(localized(folium, label('Refresh HQPlayer DSP options before applying.', '请重新读取 HQPlayer DSP 选项后再应用。')));
            try {
                const updated = await call('applyDsp', connection.settings.get(), data.revision, patch);
                if (snapshot !== data || disposed) throw new Error('HQPlayer connection changed; refresh DSP options');
                install(updated);
            } catch (error) { clear(); throw error; }
            return message(label('DSP confirmed. Playback was not restarted. Review new options after a mode change.',
                'DSP 设置已确认，未自动恢复播放；切换模式后请重新检查其他选项。'));
        };
        handles.push(folium.registries.commands.register({
            id: 'apply-dsp', label: label('Apply HQPlayer DSP draft', '应用 HQPlayer DSP 草稿', '套用 HQPlayer DSP 草稿', 'Terapkan draf DSP HQPlayer'),
            description: label('Explicitly apply the draft above. Stops only Folia-owned output, preserves position and does not resume automatically. Refuses stale options or external playback.',
                '明确应用上方草稿；仅停止本模组拥有的播放并保留进度，不自动恢复。选项已过期或其他控制器正在播放时拒绝操作。'),
            keywords: ['hqplayer dsp filter rate shaper apply', '滤波 升频 采样率 调制器 应用'],
            run: () => action(() => apply(Object.fromEntries(Object.entries(section.settings.get()).map(([key, value]) => [key, Number(value)])))),
        }));
        handles.push(folium.registries.commands.register({
            id: 'set-dsp-mode', label: label('Change HQPlayer output mode', '切换 HQPlayer 输出模式', '切換 HQPlayer 輸出模式', 'Ubah mode keluaran HQPlayer'),
            description: label('Apply the mode separately; then review the refreshed filter, shaper and rate choices. Does not restart playback.',
                '单独应用输出模式，再检查刷新后的滤波器、整形器和采样率；不会恢复播放。'),
            keywords: ['hqplayer pcm sdm dsd mode', '模式 输出'],
            params: [select('mode', label('Output mode', '输出模式', '輸出模式', 'Mode keluaran'), data.modes, data.selection.mode)],
            run: ({ values }) => action(() => apply({ mode: Number(values.mode) })),
        }));
    };
    const action = async run => {
        if (busy || disposed) throw new Error(localized(folium, label('HQPlayer DSP is busy; wait for the current operation.', 'HQPlayer DSP 正忙，请等待当前操作完成。')));
        busy = true;
        try { return await run(); }
        finally { busy = false; }
    };
    const refresh = folium.registries.commands.register({
        id: 'refresh-dsp', label: label('Read / refresh HQPlayer DSP options', '读取 / 刷新 HQPlayer DSP 选项', '讀取 / 重新整理 HQPlayer DSP 選項', 'Baca / segarkan opsi DSP HQPlayer'),
        description: label('Read-only. Replaces the draft with live settings and shows the apply/mode commands. Does not start HQPlayer or change playback.',
            '只读读取实时设置并覆盖未应用的草稿，显示应用和切换模式命令；不启动 HQPlayer、不改动播放。'),
        keywords: ['hqplayer dsp settings refresh options', '设置 滤波 升频 读取 刷新'],
        run: () => action(async () => {
            clear();
            const started = generation;
            const updated = await call('readDsp', connection.settings.get());
            if (generation !== started || disposed) throw new Error('HQPlayer connection changed; refresh DSP options');
            install(updated);
            return message(label('Live DSP options loaded in this mod. Edit the draft, then run Apply; no settings have been changed.',
                '已在本模组载入实时 DSP 选项；编辑草稿后需执行“应用”。尚未改动 HQPlayer 设置。'));
        }),
    });
    const off = connection.settings.onChange(clear);
    folium.onDispose(() => { disposed = true; off(); clear(); refresh.unregister(); });
}
