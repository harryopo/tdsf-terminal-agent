/* TDSF Terminal Agent — promotional page behaviour
   ----------------------------------------------------------------------------
   1. Hero terminal: types a short, real command sequence (visual mock only)
   2. Scroll reveal with per-group stagger
   3. Demo video fallback: shows the "drop your video here" placeholder when
      assets/video/demo.mp4 is not present
   -------------------------------------------------------------------------- */

(function () {
  "use strict";

  var reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ----------------------------- hero terminal ---------------------------- */

  var SCRIPT = [
    {
      command: "systemctl status nginx | head -3",
      lines: [
        { cls: "out", text: "● nginx.service - The nginx HTTP Server" },
        { cls: "out", text: "   Active: active (running) since Tue 2026-09-09 09:14:02 CST" },
        { cls: "out", text: "   Main PID: 1187 (nginx)" }
      ]
    },
    {
      command: "docker ps --format '{{.Names}}\\t{{.Status}}'",
      lines: [
        { cls: "out", text: "web\tUp 3 days (healthy)" },
        { cls: "out", text: "db\tUp 3 days (healthy)" }
      ]
    },
    {
      command: "df -h / | tail -1",
      lines: [
        { cls: "out", text: "/dev/vda1        99G   41G   53G  44% /" },
        { cls: "ok", text: "→ 已收集：nginx 状态 / 容器 / 磁盘水位" }
      ]
    }
  ];

  var TYPE_MIN = 42;
  var TYPE_JITTER = 46;
  var LINE_PAUSE = 170;
  var COMMAND_PAUSE = 720;

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function makeLine(cls, text) {
    var div = document.createElement("div");
    div.className = "tl";
    var span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    div.appendChild(span);
    return div;
  }

  function typeCommand(container, caret, text) {
    return new Promise(function (resolve) {
      var line = document.createElement("div");
      line.className = "tl";
      var prompt = document.createElement("span");
      prompt.className = "prompt";
      prompt.textContent = "root@lab-server:~#";
      var cmd = document.createElement("span");
      cmd.className = "cmd";
      line.appendChild(prompt);
      line.appendChild(document.createTextNode(" "));
      line.appendChild(cmd);
      line.appendChild(caret);
      container.appendChild(line);

      var i = 0;
      (function step() {
        if (i >= text.length) {
          resolve();
          return;
        }
        cmd.textContent += text.charAt(i);
        i += 1;
        setTimeout(step, TYPE_MIN + Math.random() * TYPE_JITTER);
      })();
    });
  }

  async function runHeroSequence() {
    var container = document.getElementById("terminal-body");
    var caret = document.getElementById("caret-1");
    if (!container || !caret) return;

    if (reduceMotion) {
      caret.remove();
      SCRIPT.forEach(function (entry) {
        var cmdLine = makeLine("tl", "");
        cmdLine.innerHTML = "";
        var p = document.createElement("span");
        p.className = "prompt";
        p.textContent = "root@lab-server:~#";
        var c = document.createElement("span");
        c.className = "cmd";
        c.textContent = " " + entry.command;
        cmdLine.appendChild(p);
        cmdLine.appendChild(c);
        container.appendChild(cmdLine);
        entry.lines.forEach(function (l) {
          container.appendChild(makeLine(l.cls, l.text));
        });
      });
      return;
    }

    // Start from a clean prompt line
    container.innerHTML = "";
    await typeCommand(container, caret, SCRIPT[0].command);
    // Move caret onto its own trailing line for the remaining output
    var standalone = document.createElement("div");
    standalone.className = "tl";
    standalone.appendChild(caret);
    container.appendChild(standalone);

    for (var s = 0; s < SCRIPT.length; s += 1) {
      if (s > 0) {
        // detach caret, type next command, re-attach
        var holder = document.createElement("div");
        holder.className = "tl";
        holder.appendChild(caret);
        container.appendChild(holder);
        await typeCommand(container, caret, SCRIPT[s].command);
        var again = document.createElement("div");
        again.className = "tl";
        again.appendChild(caret);
        container.appendChild(again);
      }
      for (var i = 0; i < SCRIPT[s].lines.length; i += 1) {
        container.appendChild(makeLine(SCRIPT[s].lines[i].cls, SCRIPT[s].lines[i].text));
        await wait(LINE_PAUSE);
      }
      await wait(COMMAND_PAUSE);
    }
  }

  /* ------------------------------ scroll reveal --------------------------- */

  function initReveal() {
    var items = document.querySelectorAll(".reveal");
    if (!items.length) return;

    if (reduceMotion || !("IntersectionObserver" in window)) {
      items.forEach(function (el) {
        el.classList.add("visible");
      });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );

    items.forEach(function (el) {
      observer.observe(el);
    });
  }

  /* ------------------------------ video fallback -------------------------- */

  function initVideoFallback() {
    var video = document.getElementById("demo-video");
    var placeholder = document.getElementById("video-placeholder");
    if (!video || !placeholder) return;

    // 默认：占位可见、播放器隐藏。只有当视频真的能播放时才替换占位。
    function showVideo() {
      placeholder.hidden = true;
      video.hidden = false;
    }

    video.addEventListener("loadeddata", showVideo);
    video.addEventListener("canplay", showVideo);

    // 尝试探测（文件不存在时静默留在占位状态）
    try {
      video.load();
    } catch (e) {
      /* 保持占位 */
    }
  }

  /* --------------------------------- boot --------------------------------- */

  document.addEventListener("DOMContentLoaded", function () {
    runHeroSequence();
    initReveal();
    initVideoFallback();
  });
})();
