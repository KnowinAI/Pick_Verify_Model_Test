'use strict';

// 浏览器端：自定义 VLM 接口（IP + 端口），设置保存在 localStorage。
(function (global) {
  const STORAGE_KEY = 'pick_verify_model_endpoint';

  function readState() {
    try {
      const raw = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        enabled: !!raw.enabled,
        host: String(raw.host || ''),
        port: String(raw.port || ''),
        model: String(raw.model || ''),
      };
    } catch (e) {
      return { enabled: false, host: '', port: '', model: '' };
    }
  }

  function writeState(state) {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function parseEndpointUrl(url) {
    try {
      const u = new URL(String(url || ''));
      return {
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      };
    } catch (e) {
      return { host: '', port: '' };
    }
  }

  function payloadFromState(state) {
    if (!state || !state.enabled) return {};
    const host = state.host.trim();
    const port = state.port.trim();
    if (!host || !port) return {};
    const out = { endpoint_host: host, endpoint_port: port };
    const model = state.model.trim();
    if (model) out.model = model;
    return out;
  }

  function endpointUiHtml(compact) {
    if (compact) {
      return `<span class="ep-ui ep-compact" data-ep-ui>
        <label title="临时改 VLM 服务地址（http://IP:端口/v1/chat/completions）"><input type="checkbox" data-ep-enable> 自定义接口</label>
        <input type="text" data-ep-host placeholder="IP" title="主机 / IP">
        <input type="text" data-ep-port placeholder="端口" title="端口" inputmode="numeric">
        <input type="text" data-ep-model placeholder="模型名" title="留空则用注册表里的 model 名">
      </span>`;
    }
    return `<div class="ep-ui" data-ep-ui>
      <label class="fl" style="display:flex;gap:8px;align-items:center;margin-top:8px;">
        <input type="checkbox" data-ep-enable> 自定义 VLM 接口（IP + 端口）
      </label>
      <div class="form-grid" style="margin-top:6px;">
        <div><label class="fl">主机 / IP</label><input type="text" data-ep-host placeholder="例如 101.132.143.105"></div>
        <div><label class="fl">端口</label><input type="text" data-ep-port placeholder="例如 5087" inputmode="numeric"></div>
        <div><label class="fl">模型名（可选）</label><input type="text" data-ep-model placeholder="留空用注册表默认"></div>
      </div>
      <div class="hint">勾选后请求 http://IP:端口/v1/chat/completions；设置保存在本浏览器。</div>
    </div>`;
  }

  function bind(root, options) {
    if (!root) return { getPayload: () => ({}) };
    const enabled = root.querySelector('[data-ep-enable]');
    const host = root.querySelector('[data-ep-host]');
    const port = root.querySelector('[data-ep-port]');
    const model = root.querySelector('[data-ep-model]');
    const st = readState();
    if (enabled) enabled.checked = st.enabled;
    if (host) host.value = st.host;
    if (port) port.value = st.port;
    if (model) model.value = st.model;

    function syncDisabled() {
      const on = enabled && enabled.checked;
      [host, port, model].forEach((el) => { if (el) el.disabled = !on; });
    }

    function maybePrefill() {
      if (!enabled || !enabled.checked || !host || host.value.trim()) return;
      const def = options && typeof options.defaultEndpoint === 'function' ? options.defaultEndpoint() : null;
      if (!def || !def.host) return;
      host.value = def.host;
      if (port && !port.value.trim()) port.value = def.port || '';
    }

    function emit() {
      const next = {
        enabled: !!(enabled && enabled.checked),
        host: host ? host.value : '',
        port: port ? port.value : '',
        model: model ? model.value : '',
      };
      writeState(next);
      syncDisabled();
      if (options && typeof options.onChange === 'function') options.onChange(next);
    }

    syncDisabled();
    if (enabled) {
      enabled.addEventListener('change', () => { maybePrefill(); emit(); });
    }
    [host, port, model].forEach((el) => {
      if (!el) return;
      el.addEventListener('change', emit);
      el.addEventListener('input', emit);
    });
    return { getPayload: () => payloadFromState(readState()) };
  }

  global.ModelEndpointUi = {
    readState,
    payloadFromState,
    parseEndpointUrl,
    endpointUiHtml,
    bind,
    getPayload: () => payloadFromState(readState()),
  };
})(typeof window !== 'undefined' ? window : globalThis);
