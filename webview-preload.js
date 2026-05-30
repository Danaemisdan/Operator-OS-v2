const { ipcRenderer } = require('electron');

window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'ui-update') {
    ipcRenderer.sendToHost('ui-update', event.data.payload);
  }
});

ipcRenderer.on('semantic-predictions', (event, predictions) => {
  window.dispatchEvent(new CustomEvent('semantic-predictions', { detail: predictions }));
});
