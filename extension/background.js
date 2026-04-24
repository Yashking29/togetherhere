// Minimal service worker — keeps extension alive and handles tab capture
chrome.runtime.onInstalled.addListener(() => {
  console.log('Together Watch Party installed');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'get-stream-id') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ error: 'No tab ID found' }); return false; }

    chrome.tabCapture.getMediaStreamId(
      { targetTabId: tabId, consumerTabId: tabId },
      (streamId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ streamId });
        }
      }
    );
    return true; // keep channel open for async response
  }
});
