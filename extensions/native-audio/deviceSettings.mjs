// Keeps the host's schema-rendered device selector current, using only public Folium registrations.
export const label = (en, zh) => ({ en, 'zh-CN': zh, 'zh-TW': zh, in: en });

export const deviceOptions = (devices, selected) => {
    const options = [{ value: 'auto', label: label('System default device', '系统默认设备') }];
    for (const device of devices) options.push({ value: device.id, label: label(device.name, device.name) });
    if (selected && !options.some(option => option.value === selected)) {
        options.push({ value: selected, label: label(`Saved device (not found): ${selected}`, `已保存的设备（未发现）：${selected}`) });
    }
    return options;
};

export const registerDeviceSettings = (folium, definition) => {
    // Read the legacy text value before making it a select, so an unplugged saved device never becomes "auto".
    let section = folium.registries.settingsSections.register(definition);
    let off;
    let disposed = false;
    let generation = 0;
    let devices = [];
    const listeners = new Set();
    const replace = (problem = '') => {
        const selected = section.settings.get().device;
        off?.();
        section.unregister();
        section = folium.registries.settingsSections.register({
            ...definition,
            description: problem ? label(
                `${definition.description.en} Device discovery failed: ${problem}. Use Refresh audio devices to retry.`,
                `${definition.description['zh-CN']} 设备列表获取失败：${problem}。请执行“刷新音频设备”重试。`,
            ) : definition.description,
            settings: definition.settings.map(field => field.key === 'device' ? {
                ...field, type: 'select', options: deviceOptions(devices, selected),
                label: label('Audio output device', '音频输出设备'),
                description: label('Use Refresh audio devices after connecting hardware or changing the engine. A missing saved device is retained, never replaced automatically.', '插拔设备或更换引擎后执行“刷新音频设备”。未发现的原设备会保留，不会自动换设备。'),
            } : field),
        });
        off = section.settings.onChange(() => { for (const listener of listeners) listener(); });
    };
    replace();
    const refresh = async () => {
        const token = ++generation;
        const executable = section.settings.get().executable;
        try {
            const found = await folium.rpc.call('native.listDevices', executable);
            if (disposed || token !== generation || executable !== section.settings.get().executable) return;
            devices = found;
            replace();
            return { message: `已刷新：${devices.length} 个 WASAPI 设备 / ${devices.length} WASAPI devices found` };
        } catch (error) {
            if (!disposed && token === generation && executable === section.settings.get().executable) replace(error.message);
            throw error;
        }
    };
    folium.onDispose(() => { disposed = true; generation++; off?.(); listeners.clear(); section.unregister(); });
    void refresh().catch(error => {
        if (disposed) return;
        folium.log.error('Native audio device discovery failed', error);
        folium.ui.toast(`无法获取音频设备 / Device discovery failed: ${error.message}`, { type: 'error' });
    });
    return {
        settings: {
            get: () => section.settings.get(),
            set: patch => section.settings.set(patch),
            onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        },
        refresh,
    };
};
