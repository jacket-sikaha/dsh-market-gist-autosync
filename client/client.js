window.__ModuleLoader__.load({
  id: "dsh-market-gist-autosync",
  factory: (require) => {
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
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.json().catch(function () {
          return { ok: false, code: "other", error: "HTTP " + res.status };
        });
      });
    }

    // -- tiny UI primitives (no external deps) ---------------------------------
    function SectionTitle(props) {
      var isDirty = !!props.dirty;
      return React.createElement(
        "div",
        {
          style: {
            margin: "18px 0 6px",
            fontSize: 13,
            fontWeight: 600,
            color: "#1f2328",
            display: "flex",
            alignItems: "center",
            gap: 6,
          },
        },
        React.createElement("span", {
          style: {
            display: "inline-block",
            width: 3,
            height: 14,
            background: "#4f6ef7",
            borderRadius: 2,
          },
        }),
        // 标题文字包裹一层 relative，红点用 absolute 定位到文字右上角
        React.createElement(
          "span",
          { style: { position: "relative" } },
          props.children,
          isDirty
            ? React.createElement("span", {
                title: "有未保存的修改",
                style: {
                  position: "absolute",
                  top: 2,
                  right: -8,
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "#dc2626",
                },
              })
            : null,
        ),
      );
    }

    function Hint(props) {
      return React.createElement(
        "div",
        { style: { fontSize: 11, color: "#8b93a1", marginBottom: 8 } },
        props.children,
      );
    }

    function Field(props) {
      return React.createElement(
        "div",
        { style: { marginBottom: 12 } },
        React.createElement(
          "label",
          {
            style: {
              display: "block",
              fontSize: 12,
              color: "#6b7280",
              marginBottom: 4,
            },
          },
          props.label,
        ),
        React.createElement("input", {
          type: props.type || "text",
          value: props.value,
          placeholder: props.placeholder,
          onChange: function (e) {
            props.onChange(e.target.value);
          },
          style: {
            width: "100%",
            boxSizing: "border-box",
            padding: "7px 10px",
            fontSize: 13,
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            background: "#fff",
            color: "#1f2328",
          },
        }),
        props.hint
          ? React.createElement(
              "div",
              { style: { fontSize: 11, color: "#8b93a1", marginTop: 3 } },
              props.hint,
            )
          : null,
      );
    }

    function Toggle(props) {
      return React.createElement(
        "label",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            cursor: "pointer",
          },
        },
        React.createElement("input", {
          type: "checkbox",
          checked: props.value,
          onChange: function (e) {
            props.onChange(e.target.checked);
          },
        }),
        React.createElement("span", { style: { fontSize: 13 } }, props.label),
      );
    }

    function Button(props) {
      return React.createElement(
        "button",
        {
          type: "button",
          onClick: props.onClick,
          disabled: props.disabled,
          style: {
            padding: "7px 14px",
            fontSize: 13,
            borderRadius: 6,
            cursor: props.disabled ? "default" : "pointer",
            border: "1px solid #4f6ef7",
            background: props.primary === false ? "#fff" : "#4f6ef7",
            color: props.primary === false ? "#4f6ef7" : "#fff",
            opacity: props.disabled ? 0.5 : 1,
            marginRight: 8,
          },
        },
        props.children,
      );
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
      function p(x) {
        return String(x).padStart(2, "0");
      }
      return (
        d.getFullYear() +
        "-" +
        p(d.getMonth() + 1) +
        "-" +
        p(d.getDate()) +
        " " +
        p(d.getHours()) +
        ":" +
        p(d.getMinutes())
      );
    }
    // 相对时间：用于「上次备份：x 分钟前」
    function fmtAgo(iso) {
      if (!iso) return "-";
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "-";
      var sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
      if (sec < 60) return "刚刚";
      var min = Math.floor(sec / 60);
      if (min < 60) return min + " 分钟前";
      var hr = Math.floor(min / 60);
      if (hr < 24) return hr + " 小时前";
      var day = Math.floor(hr / 24);
      if (day < 30) return day + " 天前";
      return fmtTime(iso);
    }

    // -- the settings section component ----------------------------------------
    function GistBackupSection() {
      var state = React.useState({
        loaded: false,
        gistToken: "",
        gistId: "",
        deviceName: "",
        scheduleEnabled: false,
        scheduleIntervalValue: "24",
        scheduleIntervalUnit: "hour",
        includeLock: false,
        uploads: [],
        envTokenSet: false,
        activeProfile: "desktop",
        version: "",
        restoreGist: "",
        progress: null,
        message: null,
        busy: false,
        // baseline = 已保存值的快照，用于「未保存修改」红点
        baseline: null,
        // host 报告的下次定时备份预计时间（epoch ms），关闭时为 null
        nextRunAt: null,
      });
      function setState(patch) {
        state[1](function (s) {
          return Object.assign({}, s, patch);
        });
      }
      // Toast 自动消失计时器（跨渲染存活）
      var msgTimer = React.useRef(null);

      React.useEffect(function () {
        rpc("getConfig")
          .then(function (r) {
            if (r.ok) {
              var c = r.config || {};
              var nextRunAt =
                typeof r.nextRunAt === "number" ? r.nextRunAt : null;
              setState({
                loaded: true,
                gistToken: c.gistToken || "",
                gistId: c.gistId || "",
                deviceName: c.deviceName || r.deviceNameDetected || "",
                scheduleEnabled: !!c.scheduleEnabled,
                scheduleIntervalValue: String(c.scheduleIntervalValue || 24),
                scheduleIntervalUnit:
                  c.scheduleIntervalUnit === "minute" ? "minute" : "hour",
                includeLock: !!c.includeLock,
                uploads: Array.isArray(c.uploads) ? c.uploads : [],
                envTokenSet: !!r.envTokenSet,
                activeProfile: r.activeProfile || "desktop",
                version: typeof r.version === "string" ? r.version : "",
                nextRunAt: nextRunAt,
                // 初始加载即为「已保存」状态
                baseline: {
                  gistToken: c.gistToken || "",
                  gistId: c.gistId || "",
                  includeLock: !!c.includeLock,
                  scheduleEnabled: !!c.scheduleEnabled,
                  scheduleIntervalValue: String(c.scheduleIntervalValue || 24),
                  scheduleIntervalUnit:
                    c.scheduleIntervalUnit === "minute" ? "minute" : "hour",
                },
              });
            } else {
              setState({ loaded: true, message: { ok: false, text: r.error } });
            }
          })
          .catch(function (e) {
            setState({
              loaded: true,
              message: { ok: false, text: String((e && e.message) || e) },
            });
          });
      }, []);

      // 页面可见时轮询上传记录：后台定时备份完成后，前端无需重启或手动刷新
      // 就能看到新记录。只更新 uploads 字段，不打断用户正在编辑的其他输入。
      React.useEffect(function () {
        var timer = setInterval(function () {
          rpc("listUploads")
            .then(function (u) {
              if (u && Array.isArray(u.uploads)) {
                // nextRunAt 随轮询一起刷新（定时器每跳一次都会变）
                setState({
                  uploads: u.uploads,
                  nextRunAt:
                    typeof u.nextRunAt === "number" ? u.nextRunAt : null,
                });
              }
            })
            .catch(function () {
              /* 轮询出错静默忽略，下次再试 */
            });
        }, 5000);
        return function () {
          clearInterval(timer);
        };
      }, []);

      function showMessage(r) {
        // 浮动 toast：成功 3.5s、失败 6s 后自动消失，也可手动点 ✕ 关闭
        if (msgTimer.current) {
          clearTimeout(msgTimer.current);
          msgTimer.current = null;
        }
        var m = r.ok
          ? { ok: true, text: r.message || r.gistUrl || "成功" }
          : { ok: false, text: r.error };
        setState({ message: m });
        // 成功提示里可能带一段说明（例如备份时排除了哪些本地依赖，以及原因）。
        // 固定 3.5s 对一段要读完的清单太短，等于没提示 —— 按长度放宽上限 15s。
        var base = m.ok ? 3500 : 6000;
        var scaled = Math.min(
          base + Math.max(0, String(m.text).length - 24) * 90,
          15000,
        );
        msgTimer.current = setTimeout(function () {
          msgTimer.current = null;
          setState({ message: null });
        }, scaled);
      }

      function dismissMessage() {
        if (msgTimer.current) {
          clearTimeout(msgTimer.current);
          msgTimer.current = null;
        }
        setState({ message: null });
      }

      // Token 有独立的保存按钮；这里只保存定时/备份相关设置（host 端 saveConfig
      // 是部分合并，未传字段保持磁盘原值）。
      function save() {
        setState({ busy: true });
        rpc("saveConfig", {
          config: {
            gistId: state[0].gistId,
            deviceName: state[0].deviceName,
            scheduleEnabled: state[0].scheduleEnabled,
            scheduleIntervalValue:
              parseInt(state[0].scheduleIntervalValue, 10) || 24,
            scheduleIntervalUnit: state[0].scheduleIntervalUnit,
            includeLock: state[0].includeLock,
          },
        })
          .then(function (r) {
            setState({ busy: false });
            if (r.ok) {
              // 保存成功 → 更新 baseline，红点消失
              setState({
                baseline: Object.assign({}, state[0].baseline, {
                  gistId: state[0].gistId,
                  scheduleEnabled: state[0].scheduleEnabled,
                  scheduleIntervalValue: String(state[0].scheduleIntervalValue),
                  scheduleIntervalUnit: state[0].scheduleIntervalUnit,
                  includeLock: state[0].includeLock,
                }),
              });
            }
            showMessage(r.ok ? { ok: true, message: "定时设置已保存" } : r);
          })
          .catch(function (e) {
            setState({ busy: false, message: { ok: false, text: String(e) } });
          });
      }

      function saveToken() {
        setState({ busy: true });
        rpc("saveConfig", { config: { gistToken: state[0].gistToken } })
          .then(function (r) {
            setState({ busy: false });
            if (r.ok) {
              setState({
                baseline: Object.assign({}, state[0].baseline, {
                  gistToken: state[0].gistToken,
                }),
              });
            }
            showMessage(r.ok ? { ok: true, message: "Token 已保存" } : r);
          })
          .catch(function (e) {
            setState({ busy: false, message: { ok: false, text: String(e) } });
          });
      }

      function test() {
        setState({ busy: true });
        rpc("testConnection")
          .then(function (r) {
            setState({ busy: false });
            showMessage(
              r.ok ? { ok: true, message: r.message || "连接正常" } : r,
            );
          })
          .catch(function (e) {
            setState({ busy: false, message: { ok: false, text: String(e) } });
          });
      }

      function backup() {
        // Pass the current field value: empty really means "create a fresh gist",
        // instead of silently reusing the last-saved gistId on disk.
        var gistField = state[0].gistId;
        setState({ busy: true });
        rpc("backupNow", { gist: gistField })
          .then(function (r) {
            if (r.ok) {
              // Records now live in the host's storage domain — refetch rather than
              // constructing the row client-side.
              rpc("listUploads")
                .then(function (u) {
                  // host 端 doBackup 已把新 gistId 落盘 → baseline 同步，红点消失
                  setState({
                    busy: false,
                    gistId: r.gistId,
                    uploads: (u && u.uploads) || [],
                    baseline: Object.assign({}, state[0].baseline, {
                      gistId: r.gistId,
                    }),
                  });
                })
                .catch(function () {
                  setState({
                    busy: false,
                    gistId: r.gistId,
                    baseline: Object.assign({}, state[0].baseline, {
                      gistId: r.gistId,
                    }),
                  });
                });
              // The host appends a note when machine-local deps were excluded from
              // the backup (they would be unusable on the other machines reading
              // this gist). Surface it: a plugin silently missing on the peer's
              // machine looks like data loss, and this toast is the only place the
              // reason is ever shown.
              showMessage({
                ok: true,
                message:
                  "备份成功 " +
                  fmtBytes(r.bytes) +
                  (r.isNew ? "（已新建 Gist）" : "") +
                  (r.message || ""),
              });
            } else {
              setState({ busy: false });
              showMessage(r);
            }
          })
          .catch(function (e) {
            setState({ busy: false, message: { ok: false, text: String(e) } });
          });
      }

      function clearUploads() {
        if (!window.confirm("确定清空所有上传记录？此操作不可撤销。")) return;
        rpc("clearUploads")
          .then(function () {
            setState({ uploads: [] });
            showMessage({ ok: true, message: "上传记录已清空" });
          })
          .catch(function (e) {
            showMessage({ ok: false, text: String(e) });
          });
      }

      function restore(gistValue) {
        if (
          !window.confirm(
            "恢复会合并 package.json（不删除现有插件）并覆盖其他配置文件。确定继续吗？",
          )
        )
          return;
        setState({ busy: true, progress: ["正在下载备份…"] });
        // Poll restore progress so the user sees which plugins are installing.
        var pollTimer = setInterval(function () {
          rpc("restoreProgress")
            .then(function (p) {
              if (p && p.ok && Array.isArray(p.lines) && p.lines.length > 0) {
                setState({ progress: p.lines.slice() });
              }
            })
            .catch(function () {
              /* ignore poll errors */
            });
        }, 400);
        rpc("restore", { gist: gistValue })
          .then(function (r) {
            clearInterval(pollTimer);
            setState({ busy: false, progress: (r && r.progressLines) || null });
            showMessage(r.ok ? { ok: true, message: r.message } : r);
          })
          .catch(function (e) {
            clearInterval(pollTimer);
            setState({
              busy: false,
              progress: null,
              message: { ok: false, text: String(e) },
            });
          });
      }

      var s = state[0];
      if (!s.loaded)
        return React.createElement(
          "div",
          { style: { padding: 16, fontSize: 13, color: "#8b93a1" } },
          "加载中…",
        );

      // 未保存修改检测：当前值与 baseline（上次保存/加载时的快照）对比
      var b = s.baseline || {};
      var varsDirty =
        s.gistToken !== b.gistToken ||
        s.gistId !== b.gistId ||
        s.includeLock !== b.includeLock;
      var schedDirty =
        s.scheduleEnabled !== b.scheduleEnabled ||
        String(s.scheduleIntervalValue) !== String(b.scheduleIntervalValue) ||
        s.scheduleIntervalUnit !== b.scheduleIntervalUnit;

      var msg = s.message;
      // 浮动 toast：固定在视口右上角，不随内容滚动，无需拉到底部查看
      var toastStyle = {
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 9999,
        maxWidth: 380,
        padding: "10px 34px 10px 14px",
        borderRadius: 8,
        fontSize: 13,
        lineHeight: 1.5,
        wordBreak: "break-all",
        boxShadow: "0 4px 16px rgba(0,0,0,0.14), 0 1px 4px rgba(0,0,0,0.08)",
        border: "1px solid",
        animation: "dsh-gist-toast-in 0.18s ease-out",
      };
      if (msg && msg.ok)
        toastStyle = Object.assign({}, toastStyle, {
          background: "#f0f9f2",
          color: "#1a7f37",
          borderColor: "#b7e4c7",
        });
      else if (msg)
        toastStyle = Object.assign({}, toastStyle, {
          background: "#fdf1f0",
          color: "#c0392b",
          borderColor: "#f5c6c2",
        });

      return React.createElement(
        "div",
        { style: { padding: "4px 4px 16px", maxWidth: 640 } },
        // toast 滑入动画（仅本组件使用）
        React.createElement(
          "style",
          null,
          "@keyframes dsh-gist-toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}",
        ),
        React.createElement(
          "h2",
          {
            style: {
              margin: "0 0 4px",
              fontSize: 16,
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              gap: 8,
            },
          },
          "Gist 配置备份",
          s.version
            ? React.createElement(
                "span",
                {
                  title: "dsh-market-gist-autosync 插件版本",
                  style: {
                    fontSize: 11,
                    fontWeight: 400,
                    color: "#8b93a1",
                    background: "#f0f1f3",
                    borderRadius: 10,
                    padding: "1px 8px",
                    lineHeight: "16px",
                  },
                },
                "v" + s.version,
              )
            : null,
        ),
        React.createElement(
          "p",
          { style: { margin: "0 0 8px", fontSize: 12, color: "#8b93a1" } },
          "备份当前 profile「" +
            s.activeProfile +
            "」的配置到私有 Gist，格式与插件市场（dshmarket）完全兼容、可互相恢复。",
        ),

        // ===== 备份变量设置 =====
        React.createElement(SectionTitle, { dirty: varsDirty }, "备份变量设置"),
        // Token 单独一行：输入框 + 专属「保存 Token」按钮（敏感配置独立保存）
        React.createElement(
          "div",
          { style: { marginBottom: 12 } },
          React.createElement(
            "label",
            {
              style: {
                display: "block",
                fontSize: 12,
                color: "#6b7280",
                marginBottom: 4,
              },
            },
            "Gist Token",
          ),
          React.createElement(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "center" } },
            React.createElement("input", {
              type: "password",
              value: s.gistToken,
              placeholder: "ghp_...（需要 gist 权限）",
              onChange: function (e) {
                setState({ gistToken: e.target.value });
              },
              style: {
                flex: 1,
                boxSizing: "border-box",
                padding: "7px 10px",
                fontSize: 13,
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                background: "#fff",
                color: "#1f2328",
              },
            }),
            React.createElement(
              "button",
              {
                type: "button",
                onClick: saveToken,
                disabled: s.busy,
                style: {
                  padding: "7px 14px",
                  fontSize: 13,
                  borderRadius: 6,
                  cursor: s.busy ? "default" : "pointer",
                  border: "1px solid #4f6ef7",
                  background: "#fff",
                  color: "#4f6ef7",
                  opacity: s.busy ? 0.5 : 1,
                  whiteSpace: "nowrap",
                },
              },
              "保存 Token",
            ),
          ),
          React.createElement(
            "div",
            {
              style: {
                fontSize: 11,
                color: "#8b93a1",
                marginTop: 3,
                lineHeight: 1.6,
              },
            },
            s.envTokenSet
              ? "检测到环境变量 DSH_GITHUB_TOKEN 已设置 —— 将优先使用它，此处可留空"
              : React.createElement(
                  React.Fragment,
                  null,
                  "没有 Token？点击 ",
                  React.createElement(
                    "a",
                    {
                      href: "https://github.com/settings/tokens",
                      target: "_blank",
                      rel: "noreferrer",
                      style: { color: "#4f6ef7", textDecoration: "none" },
                    },
                    "前往 GitHub 创建",
                  ),
                  "（Scope 勾选 gist 即可）。也可用环境变量 DSH_GITHUB_TOKEN 代替",
                  React.createElement(
                    "div",
                    { style: { marginTop: 2, color: "#a16207" } },
                    "⚠ 修改 Token 后请点「保存 Token」，否则不会生效",
                  ),
                ),
          ),
        ),
        React.createElement(Field, {
          label: "Gist ID 或 URL",
          value: s.gistId,
          placeholder:
            "留空则每次新建；填已有 gist id 或 https://gist.github.com/<user>/<id> 则更新它",
          onChange: function (v) {
            setState({ gistId: v });
          },
          hint: "新建成功后会自动把 gist id 存回这里",
        }),
        React.createElement(Toggle, {
          label: "同时备份 pnpm-lock.yaml（精确复现依赖版本，约 115KB）",
          value: s.includeLock,
          onChange: function (v) {
            setState({ includeLock: v });
          },
        }),

        // ===== 执行 =====
        React.createElement(SectionTitle, { dirty: schedDirty }, "执行"),
        React.createElement(Toggle, {
          label: "定时备份",
          value: s.scheduleEnabled,
          onChange: function (v) {
            setState({ scheduleEnabled: v });
          },
        }),
        s.scheduleEnabled
          ? React.createElement(
              "div",
              {
                style: {
                  fontSize: 11,
                  color: "#b45309",
                  background: "#fef3c7",
                  border: "1px solid #fcd34d",
                  borderRadius: 6,
                  padding: "6px 10px",
                  margin: "0 0 10px",
                  lineHeight: 1.6,
                },
              },
              "⚠ 定时备份仅在 DSH 运行期间执行。DSH 关闭、退出或电脑休眠时不会备份，也不会补跑错过的周期。",
            )
          : null,
        React.createElement(
          "div",
          {
            style: {
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 12,
            },
          },
          React.createElement(
            "span",
            { style: { fontSize: 12, color: "#6b7280" } },
            "每隔",
          ),
          React.createElement("input", {
            type: "number",
            min: "1",
            value: s.scheduleIntervalValue,
            onChange: function (e) {
              setState({ scheduleIntervalValue: e.target.value });
            },
            style: {
              width: 80,
              padding: "7px 10px",
              fontSize: 13,
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              boxSizing: "border-box",
            },
          }),
          React.createElement(
            "select",
            {
              value: s.scheduleIntervalUnit,
              onChange: function (e) {
                setState({ scheduleIntervalUnit: e.target.value });
              },
              style: {
                padding: "7px 10px",
                fontSize: 13,
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                background: "#fff",
              },
            },
            React.createElement("option", { value: "minute" }, "分钟"),
            React.createElement("option", { value: "hour" }, "小时"),
          ),
          React.createElement(
            "span",
            { style: { fontSize: 11, color: "#8b93a1" } },
            "执行一次",
          ),
        ),
        // 上次备份 + 下次预计：nextRunAt 由 host 随轮询刷新。
        // “上次备份”指最近一次成功备份——失败的尝试不算，否则一个失败的
        // 定时会让 UI 显示“上次备份：刚刚”，掩盖备份链实际已断。
        (function () {
          var lastOk =
            s.uploads && s.uploads.find(function (u) { return u.status !== "failed"; });
          var lastText = lastOk
            ? "上次备份：" + fmtAgo(lastOk.uploadedAt)
            : s.uploads && s.uploads.length > 0
              ? "上次成功备份：无"
              : "尚未备份";
          return React.createElement(
            "div",
            { style: { fontSize: 11, color: "#8b93a1", margin: "0 0 10px" } },
            lastText,
            s.scheduleEnabled
              ? s.nextRunAt
                ? " · 下次预计：" + fmtTime(new Date(s.nextRunAt).toISOString())
                : ""
              : " · 定时备份未开启",
          );
        })(),
        React.createElement(
          "div",
          { style: { marginTop: 4 } },
          React.createElement(
            Button,
            { onClick: save, disabled: s.busy, primary: false },
            "保存定时设置",
          ),
          React.createElement(
            Button,
            { onClick: test, disabled: s.busy, primary: false },
            "测试连接",
          ),
          React.createElement(
            Button,
            { onClick: backup, disabled: s.busy },
            "立即备份",
          ),
        ),

        // ===== 恢复 =====
        React.createElement(SectionTitle, null, "恢复"),
        React.createElement(
          Hint,
          null,
          "兼容插件市场（dshmarket）的备份。合并恢复：package.json 与现有插件合并（不删除已装插件），其他配置文件覆盖。重启后生效。",
        ),
        React.createElement(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center" } },
          React.createElement("input", {
            type: "text",
            value: s.restoreGist,
            placeholder: "Gist id 或 URL（留空用上方已保存的 Gist ID）",
            onChange: function (e) {
              setState({ restoreGist: e.target.value });
            },
            style: {
              flex: 1,
              padding: "7px 10px",
              fontSize: 13,
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              boxSizing: "border-box",
            },
          }),
          React.createElement(
            Button,
            {
              onClick: function () {
                restore(s.restoreGist);
              },
              disabled: s.busy,
              primary: false,
            },
            "恢复",
          ),
        ),
        // 恢复进度（实时显示正在安装哪些插件）
        s.progress && s.progress.length > 0
          ? React.createElement(
              "div",
              {
                style: {
                  margin: "8px 0",
                  padding: "8px 12px",
                  background: "#f6f8fa",
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: "monospace",
                  color: "#4b5563",
                  maxHeight: 140,
                  overflowY: "auto",
                },
              },
              s.progress.map(function (line, i) {
                return React.createElement(
                  "div",
                  { key: i, style: { padding: "1px 0" } },
                  line,
                );
              }),
            )
          : null,

        // ===== 上传记录 =====
        React.createElement(
          "div",
          {
            style: {
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              margin: "20px 0 8px",
            },
          },
          React.createElement(
            "span",
            { style: { fontSize: 13, fontWeight: 600, color: "#4b5563" } },
            "上传记录",
          ),
          s.uploads && s.uploads.length > 0
            ? React.createElement(
                "button",
                {
                  onClick: clearUploads,
                  style: {
                    border: "1px solid #e5e7eb",
                    borderRadius: 6,
                    padding: "2px 10px",
                    fontSize: 12,
                    background: "#fff",
                    color: "#b91c1c",
                    cursor: "pointer",
                  },
                },
                "清空记录",
              )
            : null,
        ),
        s.uploads && s.uploads.length > 0
          ? React.createElement(
              "div",
              {
                style: {
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  overflow: "hidden",
                },
              },
              // 表头与数据行同处一个滚动容器：sticky 表头 + 同一 grid 模板，
              // 滚动条出现时两者列宽依然对齐（表头不再单独占一行宽）
              React.createElement(
                "div",
                { style: { maxHeight: 240, overflowY: "auto" } },
                // 表头（sticky 固定在滚动区顶部）
                React.createElement(
                  "div",
                  {
                    style: {
                      display: "grid",
                      gridTemplateColumns: "1fr 64px 84px 140px 56px 64px",
                      gap: 8,
                      padding: "6px 12px",
                      fontSize: 11,
                      color: "#8b93a1",
                      background: "#f6f8fa",
                      borderBottom: "1px solid #e5e7eb",
                      position: "sticky",
                      top: 0,
                      zIndex: 1,
                    },
                  },
                  React.createElement("span", null, "Gist ID"),
                  React.createElement("span", null, "执行方式"),
                  React.createElement("span", null, "设备"),
                  React.createElement("span", null, "上传时间"),
                  React.createElement("span", null, "状态"),
                  React.createElement(
                    "span",
                    { style: { textAlign: "right" } },
                    "大小",
                  ),
                ),
                s.uploads.map(function (u, idx) {
                  var isFailed = u.status === "failed";
                  var isNew = u.status === "new";
                  var badgeStyle = {
                    display: "inline-block",
                    padding: "1px 7px",
                    borderRadius: 10,
                    fontSize: 11,
                    lineHeight: "16px",
                    background: isFailed
                      ? "#fef2f2"
                      : isNew
                        ? "#e8f0fe"
                        : "#f0f1f3",
                    color: isFailed
                      ? "#b91c1c"
                      : isNew
                        ? "#1a56db"
                        : "#4b5563",
                  };
                  var badgeText = isFailed ? "失败" : isNew ? "新建" : "更新";
                  // 执行方式：定时器触发 or 手动点击；旧记录无 source 字段 → "-"
                  var srcLabel =
                    u.source === "scheduled"
                      ? "定时"
                      : u.source === "manual"
                        ? "手动"
                        : "-";
                  var srcStyle = {
                    display: "inline-block",
                    padding: "1px 6px",
                    borderRadius: 10,
                    fontSize: 11,
                    lineHeight: "16px",
                    background:
                      u.source === "scheduled"
                        ? "#e8f0fe"
                        : u.source === "manual"
                          ? "#f3e8fe"
                          : "#f0f1f3",
                    color:
                      u.source === "scheduled"
                        ? "#1a56db"
                        : u.source === "manual"
                          ? "#7c3aed"
                          : "#4b5563",
                  };
                  return React.createElement(
                    "div",
                    {
                      key: (u.uploadedAt || "") + idx,
                      style: {
                        display: "grid",
                        gridTemplateColumns: "1fr 64px 84px 140px 56px 64px",
                        gap: 8,
                        padding: "7px 12px",
                        borderTop: "1px solid #f0f1f3",
                        fontSize: 12,
                        alignItems: "center",
                      },
                    },
                    React.createElement(
                      "a",
                      {
                        href: "https://gist.github.com/" + u.gistId,
                        target: "_blank",
                        rel: "noreferrer",
                        style: {
                          color: "#4f6ef7",
                          textDecoration: "none",
                          fontFamily: "monospace",
                          fontSize: 11,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        },
                        title: u.gistId,
                      },
                      u.gistId,
                    ),
                    React.createElement("span", { style: srcStyle }, srcLabel),
                    React.createElement(
                      "span",
                      {
                        style: {
                          color: "#4b5563",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        },
                        title: u.deviceName,
                      },
                      u.deviceName || "-",
                    ),
                    React.createElement(
                      "span",
                      { style: { color: "#8b93a1", fontSize: 11 } },
                      fmtTime(u.uploadedAt),
                    ),
                    React.createElement(
                      "span",
                      { style: badgeStyle, title: isFailed ? u.error || "" : "" },
                      badgeText,
                    ),
                    React.createElement(
                      "span",
                      { style: { color: "#8b93a1", textAlign: "right" } },
                      isFailed ? "-" : fmtBytes(u.bytes),
                    ),
                  );
                }),
              ),
            )
          : React.createElement(Hint, null, "暂无上传记录"),

        // 浮动 toast 提示（右上角，自动消失，可手动关闭）
        msg
          ? React.createElement(
              "div",
              { style: toastStyle },
              msg.text,
              React.createElement(
                "button",
                {
                  type: "button",
                  onClick: dismissMessage,
                  title: "关闭",
                  style: {
                    position: "absolute",
                    top: 6,
                    right: 8,
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1,
                    color: "inherit",
                    opacity: 0.6,
                    padding: 2,
                  },
                },
                "✕",
              ),
            )
          : null,
      );
    }

    // -- plugin entry -----------------------------------------------------------
    var name = "dsh-market-gist-autosync";
    var inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "gist-backup",
            order: 41,
            label: function () {
              return "Gist 备份";
            },
          },
          function () {
            return React.createElement(GistBackupSection);
          },
        );
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
