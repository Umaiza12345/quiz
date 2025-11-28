// utils/charts.js
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

async function makeBarChartBase64(data = [], opts = {}) {
  // data: array of { label, value } or { x, y }
  const width = opts.width || 800;
  const height = opts.height || 600;
  const title = opts.title || '';

  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

  const labels = data.map(d => d.label ?? d.x ?? '');
  const values = data.map(d => d.value ?? d.y ?? 0);

  const configuration = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: title || 'Data',
          data: values
        }
      ]
    },
    options: {
      plugins: { legend: { display: false }, title: { display: !!title, text: title } }
    }
  };

  const buffer = await chartJSNodeCanvas.renderToBuffer(configuration);
  return buffer.toString('base64'); // caller can prefix data:image/png;base64,
}

module.exports = { makeBarChartBase64 };
