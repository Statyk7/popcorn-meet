// When the extension icon is clicked, send a toggle message to the active tab's content script.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.startsWith("https://meet.google.com/")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" });
  } catch {
    // Content script not yet injected — ignore
  }
});
