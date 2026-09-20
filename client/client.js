window.__ModuleLoader__.load({ id: "dsh-market-gist-autosync", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;

  var React = require("react");

  // -- minimal same-origin fetch helper --------------------------------------
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

  // -- tiny UI primitives (no external deps) ---------------------------------
  function SectionTitle(props) {
    return React.createElement("div", { style: { margin: "18px 0 6px", fontSize: 13, fontWeight: 600, color: "#1f2328", display: "flex", alignItems: "center", gap: 6 } },
      React.createElement("span", { style: { display: "inline-block", width: 3, height: 14, background: "#4f6ef7", borderRadius: 2 } }),
      props.children
    );
  }

  function Hint(props) {
    return React.createElement("div", { style: { fontSize: 11, color: "#8b93a1", marginBottom: 8 } }, props.children);
  }

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

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }
  function fmtTime(iso) {
    if (!iso) return "-";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    function p(x) { return String(x).padStart(2, "0"); }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // -- the settings section component ----------------------------------------
  function GistBackupSection() {
    var state = React.useState({
      loaded: false,
      gistToken: "", gistId: "", deviceName: "",
      scheduleEnabled: false, scheduleIntervalValue: "24", scheduleIntervalUnit: "hour",
      includeLock: false, uploads: [], envTokenSet: false, activeProfile: "desktop",
      restoreGist: "", message: null, busy: false
    });
    function setState(patch) { state[1](function (s) { return Object.assign({}, s, patch); }); }

    React.useEffect(function () {
      rpc("getConfig").then(function (r) {
        if (r.ok) {
          var c = r.config || {};
          setState({
            loaded: true,
            gistToken: c.gistToken || "",
            gistId: c.gistId || "",
            deviceName: c.deviceName || r.deviceNameDetected || "",
            scheduleEnabled: !!c.scheduleEnabled,
            scheduleIntervalValue: String(c.scheduleIntervalValue || 24),
            scheduleIntervalUnit: c.scheduleIntervalUnit === "minute" ? "minute" : "hour",
            includeLock: !!c.includeLock,
            uploads: Array.isArray(c.uploads) ? c.uploads : [],
            envTokenSet: !!r.envTokenSet,
            activeProfile: r.activeProfile || "desktop"
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
        deviceName: state[0].deviceName, scheduleEnabled: state[0].scheduleEnabled,
        scheduleIntervalValue: parseInt(state[0].scheduleIntervalValue, 10) || 24,
        scheduleIntervalUnit: state[0].scheduleIntervalUnit,
        includeLock: state[0].includeLock
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
        if (r.ok) {
          // refresh uploads + gistId after a successful backup
          var uploads = state[0].uploads.slice();
          uploads.unshift({ gistId: r.gistId, gistUrl: r.gistUrl, bytes: r.bytes, createdAt: r.createdAt, updatedAt: r.updatedAt });
          setState({ busy: false, gistId: r.gistId, uploads: uploads.slice(0, 20) });
          showMessage({ ok: true, message: "备份成功 " + fmtBytes(r.bytes) });
        } else {
          setState({ busy: false });
          showMessage(r);
        }
      }).catch(function (e) {
        setState({ busy: false, message: { ok: false, text: String(e) } });
      });
    }

    function restore(gistValue) {
      if (!window.confirm("恢复会合并 package.json（不删除现有插件）并覆盖其他配置文件。确定继续吗？")) return;
      setState({ busy: true });
      rpc("restore", { gist: gistValue }).then(function (r) {
        setState({ busy: false });
        showMessage(r.ok ? { ok: true, message: r.message } : r);
      }).catch(function (e) {
        setState({ busy: false, message: { ok: false, text: String(e) } });
      });
    }

    var s = state[0];
    if (!s.loaded) return React.createElement("div", { style: { padding: 16, fontSize: 13, color: "#8b93a1" } }, "加载中…");

    var msg = s.message;
    var msgStyle = { marginTop: 12, padding: "8px 12px", borderRadius: 6, fontSize: 13 };
    if (msg && msg.ok) msgStyle = Object.assign({}, msgStyle, { background: "#e8f7ec", color: "#1a7f37" });
    else if (msg) msgStyle = Object.assign({}, msgStyle, { background: "#fdecea", color: "#c0392b" });

    return React.createElement("div", { style: { padding: "4px 4px 16px", maxWidth: 640 } },
      React.createElement("h2", { style: { margin: "0 0 4px", fontSize: 16, fontWeight: 500 } }, "Gist 配置备份"),
      React.createElement("p", { style: { margin: "0 0 8px", fontSize: 12, color: "#8b93a1" } },
        "备份当前 profile「" + s.activeProfile + "」的配置到私有 Gist，格式与插件市场（dshmarket）完全兼容、可互相恢复。"
      ),

      // ===== 备份变量设置 =====
      React.createElement(SectionTitle, null, "备份变量设置"),
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
        placeholder: "留空则每次新建；填已有 gist id 或 https://gist.github.com/<user>/<id> 则更新它",
        onChange: function (v) { setState({ gistId: v }); },
        hint: "新建成功后会自动把 gist id 存回这里"
      }),
      React.createElement(Toggle, {
        label: "同时备份 pnpm-lock.yaml（精确复现依赖版本，约 115KB）", value: s.includeLock,
        onChange: function (v) { setState({ includeLock: v }); }
      }),

      // ===== 执行 =====
      React.createElement(SectionTitle, null, "执行"),
      React.createElement(Toggle, {
        label: "定时备份", value: s.scheduleEnabled,
        onChange: function (v) { setState({ scheduleEnabled: v }); }
      }),
      React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 12 } },
        React.createElement("span", { style: { fontSize: 12, color: "#6b7280" } }, "每隔"),
        React.createElement("input", {
          type: "number", min: "1", value: s.scheduleIntervalValue,
          onChange: function (e) { setState({ scheduleIntervalValue: e.target.value }); },
          style: { width: 80, padding: "7px 10px", fontSize: 13, border: "1px solid #e5e7eb", borderRadius: 6, boxSizing: "border-box" }
        }),
        React.createElement("select", {
          value: s.scheduleIntervalUnit,
          onChange: function (e) { setState({ scheduleIntervalUnit: e.target.value }); },
          style: { padding: "7px 10px", fontSize: 13, border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff" }
        },
          React.createElement("option", { value: "minute" }, "分钟"),
          React.createElement("option", { value: "hour" }, "小时")
        ),
        React.createElement("span", { style: { fontSize: 11, color: "#8b93a1" } }, "执行一次")
      ),
      React.createElement("div", { style: { marginTop: 4 } },
        React.createElement(Button, { onClick: save, disabled: s.busy }, "保存配置"),
        React.createElement(Button, { onClick: test, disabled: s.busy, primary: false }, "测试连接"),
        React.createElement(Button, { onClick: backup, disabled: s.busy, primary: false }, "立即备份")
      ),

      // ===== 恢复 =====
      React.createElement(SectionTitle, null, "恢复"),
      React.createElement(Hint, null, "兼容插件市场（dshmarket）的备份。合并恢复：package.json 与现有插件合并（不删除已装插件），其他配置文件覆盖。重启后生效。"),
      React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
        React.createElement("input", {
          type: "text", value: s.restoreGist, placeholder: "Gist id 或 URL（留空用上方已保存的 Gist ID）",
          onChange: function (e) { setState({ restoreGist: e.target.value }); },
          style: { flex: 1, padding: "7px 10px", fontSize: 13, border: "1px solid #e5e7eb", borderRadius: 6, boxSizing: "border-box" }
        }),
        React.createElement(Button, { onClick: function () { restore(s.restoreGist); }, disabled: s.busy, primary: false }, "恢复")
      ),

      // ===== 上传记录 =====
      React.createElement(SectionTitle, null, "上传记录"),
      (s.uploads && s.uploads.length > 0)
        ? React.createElement("div", { style: { border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" } },
            s.uploads.map(function (u, idx) {
              return React.createElement("div", {
                key: u.gistId + idx,
                style: { padding: "8px 12px", borderTop: idx === 0 ? "none" : "1px solid #f0f1f3", fontSize: 12 }
              },
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 } },
                  React.createElement("a", { href: u.gistUrl, target: "_blank", rel: "noreferrer", style: { color: "#4f6ef7", textDecoration: "none", fontFamily: "monospace", fontSize: 12 } }, u.gistId),
                  React.createElement("span", { style: { color: "#8b93a1", whiteSpace: "nowrap" } }, fmtBytes(u.bytes))
                ),
                React.createElement("div", { style: { color: "#8b93a1", marginTop: 3, fontSize: 11 } },
                  "创建 " + fmtTime(u.createdAt) + " · 更新 " + fmtTime(u.updatedAt)
                )
              );
            })
          )
        : React.createElement(Hint, null, "暂无上传记录"),

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
