/* ------------------------------------------------------------------ *
 * 首屏预涂：在 CSS 生效之前把 data-theme 写上。
 *
 * 为什么单独一个文件而不是 index.html 里的内联脚本：生产包收紧了 CSP
 * （script-src 'self'，见 src/main/index.ts），内联脚本会被拦。
 * 真值存在 settings.json，但那是异步才读得到的；这里读上一次写进
 * localStorage 的镜像 —— 于是「第一次启动可能闪一下，之后都不会」。
 * ------------------------------------------------------------------ */
(function () {
  var mode = 'dark';
  try {
    var v = localStorage.getItem('aitm.theme');
    if (v === 'light' || v === 'system' || v === 'dark') mode = v;
  } catch (e) {
    /* 隐私模式或没有 storage 权限：按深色来 */
  }
  var light = mode === 'light' || (mode === 'system' && !(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  var root = document.documentElement;
  root.setAttribute('data-theme', light ? 'light' : 'dark');
  root.setAttribute('data-theme-mode', mode);
  var accent = 'blue';
  try {
    var a = localStorage.getItem('aitm.accent');
    if (a === 'green' || a === 'azure' || a === 'wine' || a === 'ochre' || a === 'paper') accent = a;
  } catch (e) { /* 同上，按默认来 */ }
  if (accent !== 'blue') root.setAttribute('data-accent', accent); // blue 就是 :root 本体，不用写
})();
