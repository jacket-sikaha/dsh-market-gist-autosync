window.__ModuleLoader__.load({ id: "dsh-market-gist-autosync", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;

  var React = require("react");

  // -- minimal same-origin fetch helper (mirrors dshmarket's `api()`) ---------
  function api(path) {
    var relative = path.replace(/^\/+/, "");
    if (typeof document === "undefined") return "/" + relative;
    return new URL(relative, document.baseURI).pathname;
  }

  function rpc(action, extra) {
    var body = { action: action };
    if (extra !== undefined) body = Object.assign({}, body, extra);
    return fetch(api("/dsh-market-gist-autosync/rpc"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, code: "other", error: "HTTP " + res.status }; });
    });
  }

  // -- tiny controlled-field helpers (no primitives dependency) --------------
  function Field(props) {
    return React.createElement("div", { style: { marginBottom: 12 } },
      React.createElement("label", { style: { display: "block", fontSize: 12, color: "#6b7280", marginBottom: 4 } }, props.label),
      React.createElement("input", {
        type: props.type || "text",
        value: props.value,
        placeholder: props.placeholder,
        onChange: function (e) { props.onChange(e.target.value); },
        style: {
          width: "100%", boxSizing: "border-box", padding: "7px 10px", fontSize: 13,
          border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff", color: "#1f2328"
        }
      }),
      props.hint ? React.createElement("div", { style: { fontSize: 11, color: "#8b93a1", marginTop: 3 } }, props.hint) : null
    );
  }

  function Toggle(props) {
    return React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, cursor: "pointer" } },
      React.createElement("input", {
        type: "checkbox",
        checked: props.value,
        onChange: function (e) { props.onChange(e.target.checked); }
      }),
      React.createElement("span", { style: { fontSize: 13 } }, props.label)
    );
  }

  function Button(props) {
    return React.createElement("button", {
      type: "button",
      onClick: props.onClick,
      disabled: props.disabled,
      style: {
        padding: "7px 14px", fontSize: 13, borderRadius: 6, cursor: props.disabled ? "default" : "pointer",
        border: "1px solid #4f6ef7", background: props.primary === false ? "#fff" : "#4f6ef7",
        color: props.primary === false ? "#4f6ef7" : "#fff", opacity: props.disabled ? 0.5 : 1,
        marginRight: 8
      }
    }, props.children);
  }

  // -- the settings section component ----------------------------------------
  function GistBackupSection() {
    var cfg = {
      gistToken: "", gistId: "", fileNamePrefix: "config", fileName: "",
      deviceName: "", scheduleEnabled: false, scheduleIntervalHours: 24, include: []
    };
    var state = React.useState({ loaded: false, gistToken: "", gistId: "", fileNamePrefix: "config", fileName: "", deviceName: "", scheduleEnabled: false, scheduleIntervalHours: "24", include: [], catalog: [], envTokenSet: false, message: null, busy: false });

    function setState(patch) { state[1](function (s) { return Object.assign({}, s, patch); }); }

    React.useEffect(function () {
      rpc("getConfig").then(function (r) {
        if (r.ok) {
          var c = r.config || cfg;
          setState({
            loaded: true,
            gistToken: c.gistToken || "",
            gistId: c.gistId || "",
            fileNamePrefix: c.fileNamePrefix || "config",
            fileName: c.fileName || "",
            deviceName: c.deviceName || r.deviceNameDetected || "",
            scheduleEnabled: !!c.scheduleEnabled,
            scheduleIntervalHours: String(c.scheduleIntervalHours || 24),
            include: Array.isArray(c.include) ? c.include : [],
            catalog: Array.isArray(r.catalog) ? r.catalog : [],
            envTokenSet: !!r.envTokenSet
          });
        } else {
          setState({ loaded: true, message: { ok: false, text: r.error } });
        }
      }).catch(function (e) {
        setState({ loaded: true, message: { ok: false, text: String(e && e.message || e) } });
      });
    }, []);

    function showMessage(r) {
      setState({ message: r.ok ? { ok: true, text: r.message || r.gistUrl || "成功" } : { ok: false, text: r.error } });
    }

    function save() {
      setState({ busy: true });
      rpc("saveConfig", { config: {
        gistToken: state[0].gistToken, gistId: state[0].gistId,
        fileNamePrefix: state[0].fileNamePrefix, fileName: state[0].fileName,
        deviceName: state[0].deviceName, scheduleEnabled: state[0].scheduleEnabled,
        scheduleIntervalHours: parseInt(state[0].scheduleIntervalHours, 10) || 24,
        include: state[0].include
      } }).then(function (r) {
        setState({ busy: false });
        showMessage(r.ok ? { ok: true, message: "已保存" } : r);
      }).catch(function (e) {
        setState({ busy: false, message: { ok: false, text: String(e) } });
      });
    }

    function test() {
      setState({ busy: true });
      rpc("testConnection").then(function (r) {
        setState({ busy: false });
        showMessage(r.ok ? { ok: true, message: r.message || "连接正常" } : r);
      }).catch(function (e) {
        setState({ busy: false, message: { ok: false, text: String(e) } });
      });
    }

    function backup() {
      setState({ busy: true });
      rpc("backupNow").then(function (r) {
        setState({ busy: false });
        showMessage(r);
      }).catch(function (e) {
        setState({ busy: false, message: { ok: false, text: String(e) } });
      });
    }

    function toggleInclude(id, on) {
      var cur = state[0].include.slice();
      var i = cur.indexOf(id);
      if (on && i === -1) cur.push(id);
      if (!on && i !== -1) cur.splice(i, 1);
      setState({ include: cur });
    }

    var s = state[0];
    if (!s.loaded) return React.createElement("div", { style: { padding: 16, fontSize: 13, color: "#8b93a1" } }, "加载中…");

    var msg = s.message;
    var msgStyle = { marginTop: 12, padding: "8px 12px", borderRadius: 6, fontSize: 13 };
    if (msg && msg.ok) msgStyle = Object.assign({}, msgStyle, { background: "#e8f7ec", color: "#1a7f37" });
    else if (msg) msgStyle = Object.assign({}, msgStyle, { background: "#fdecea", color: "#c0392b" });

    return React.createElement("div", { style: { padding: "4px 4px 16px" } },
      React.createElement("h2", { style: { margin: "0 0 4px", fontSize: 16, fontWeight: 500 } }, "Gist 配置备份"),
      React.createElement("p", { style: { margin: "0 0 16px", fontSize: 12, color: "#8b93a1" } }, "把 DSH 配置定时备份到 GitHub Gist（私有）。token 以明文保存在本地 config.json。"),

      React.createElement(Field, {
        label: "Gist Token", type: "password", value: s.gistToken,
        placeholder: "ghp_...（需要 gist 权限）",
        onChange: function (v) { setState({ gistToken: v }); },
        hint: s.envTokenSet
          ? "检测到环境变量 DSH_GITHUB_TOKEN 已设置 —— 将优先使用它，此处可留空"
          : "创建：GitHub → Settings → Developer settings → Personal access tokens（勾选 gist 权限）。也可设环境变量 DSH_GITHUB_TOKEN 替代"
      }),
      React.createElement(Field, {
        label: "Gist ID 或 URL", value: s.gistId,
        placeholder: "留空则每次新建；填已有 gist id 或 https://gist.github.com/<id>",
        onChange: function (v) { setState({ gistId: v }); }
      }),
      React.createElement(Field, {
        label: "文件名前缀", value: s.fileNamePrefix,
        placeholder: "config",
        onChange: function (v) { setState({ fileNamePrefix: v }); },
        hint: "自动命名 = 前缀 + 时间戳 + 设备名，例如 config-20260918-163000-DESKTOP.json"
      }),
      React.createElement(Field, {
        label: "自定义文件名（可选）", value: s.fileName,
        placeholder: "留空用自动命名",
        onChange: function (v) { setState({ fileName: v }); }
      }),
      React.createElement(Field, {
        label: "设备名", value: s.deviceName,
        placeholder: "留空自动探测",
        onChange: function (v) { setState({ deviceName: v }); }
      }),

      // ---- backup content checklist (required greyed / optional checkable) ----
      React.createElement("div", { style: { margin: "16px 0 4px", fontSize: 13, fontWeight: 600, color: "#1f2328" } }, "备份内容"),
      React.createElement("div", { style: { fontSize: 11, color: "#8b93a1", marginBottom: 8 } }, "必选为恢复核心配置；可选项勾选后才会打包（避免超过 Gist 1MB 限制）"),
      React.createElement("div", { style: { border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", marginBottom: 14 } },
        (s.catalog || []).map(function (u, idx) {
          var checked = u.required || s.include.indexOf(u.id) !== -1;
          return React.createElement("label", {
            key: u.id,
            style: {
              display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 12px",
              cursor: u.required ? "default" : "pointer",
              background: u.required ? "#f7f8fa" : "#fff",
              borderTop: idx === 0 ? "none" : "1px solid #f0f1f3"
            }
          },
            React.createElement("input", {
              type: "checkbox", checked: checked, disabled: u.required,
              onChange: function (e) { toggleInclude(u.id, e.target.checked); },
              style: { marginTop: 2 }
            }),
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 13, color: u.required ? "#6b7280" : "#1f2328" } },
                u.label,
                u.required ? React.createElement("span", { style: { marginLeft: 6, fontSize: 10, color: "#8b93a1", border: "1px solid #e5e7eb", borderRadius: 4, padding: "0 4px" } }, "必选") : null
              ),
              React.createElement("div", { style: { fontSize: 11, color: "#8b93a1", marginTop: 2 } }, u.description)
            )
          );
        })
      ),

      React.createElement(Toggle, {
        label: "定时备份", value: s.scheduleEnabled,
        onChange: function (v) { setState({ scheduleEnabled: v }); }
      }),
      React.createElement(Field, {
        label: "周期间隔（小时）", value: s.scheduleIntervalHours,
        onChange: function (v) { setState({ scheduleIntervalHours: v }); }
      }),

      React.createElement("div", { style: { marginTop: 8 } },
        React.createElement(Button, { onClick: save, disabled: s.busy }, "保存配置"),
        React.createElement(Button, { onClick: test, disabled: s.busy, primary: false }, "测试连接"),
        React.createElement(Button, { onClick: backup, disabled: s.busy, primary: false }, "立即备份")
      ),

      msg ? React.createElement("div", { style: msgStyle }, msg.text) : null
    );
  }

  // -- plugin entry -----------------------------------------------------------
  var name = "dsh-market-gist-autosync";
  var inject = ["slots"];

  function apply(ctx) {
    ctx.slots.inject("settings.section", function () {
      return ctx.slots.register({
        name: "settings.section",
        id: "gist-backup",
        order: 41,
        label: function () { return "Gist 备份"; }
      }, function () { return React.createElement(GistBackupSection); });
    });
  }

  exports.name = name;
  exports.inject = inject;
  exports.apply = apply;
  return module.exports;
}});
