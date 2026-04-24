// Minimal service worker — keeps extension alive
chrome.runtime.onInstalled.addListener(() => {
  console.log('Together Watch Party installed');
});
