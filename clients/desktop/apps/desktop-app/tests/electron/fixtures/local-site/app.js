(() => {
  const badge = document.querySelector('#fixture-badge');
  const report = document.querySelector('#asset-report');
  const renderReport = () => {
    report.textContent = `script-ok|${badge.naturalWidth}|${getComputedStyle(report).color}`;
  };
  if (badge.complete) {
    renderReport();
  } else {
    badge.addEventListener('load', renderReport, { once: true });
  }
})();
