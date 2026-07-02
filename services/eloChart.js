const QuickChart = require('quickchart-js');

async function generateEloChart(data) {
  const labels = data.map((_, index) => `${index + 1}`);
  const values = data.map(point => point.elo);

  const chart = new QuickChart();
  chart.setWidth(900);
  chart.setHeight(450);
  chart.setBackgroundColor('#0f172a');
  chart.setConfig({
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'ELO',
        data: values,
        fill: true,
        borderColor: '#f97316',
        backgroundColor: 'rgba(249, 115, 22, 0.18)',
        pointBackgroundColor: '#facc15',
        pointBorderColor: '#f97316',
        pointRadius: 3,
        borderWidth: 3,
        tension: 0.35
      }]
    },
    options: {
      legend: {
        labels: { fontColor: '#e5e7eb' }
      },
      scales: {
        xAxes: [{
          scaleLabel: { display: true, labelString: 'Match order', fontColor: '#cbd5e1' },
          ticks: { fontColor: '#cbd5e1' },
          gridLines: { color: 'rgba(148, 163, 184, 0.15)' }
        }],
        yAxes: [{
          scaleLabel: { display: true, labelString: 'ELO', fontColor: '#cbd5e1' },
          ticks: { fontColor: '#cbd5e1' },
          gridLines: { color: 'rgba(148, 163, 184, 0.15)' }
        }]
      }
    }
  });

  return chart.toBinary();
}

module.exports = {
  generateEloChart
};
