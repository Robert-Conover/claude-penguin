// Only loaded on ?bridge=1, before Ruffle starts the preserved client.
window.RufflePlayer.config.urlRewriteRules = [
  [/^https?:\/\/[^/]+\/media\/play\/v2\/client\/engine\.swf(?:\?.*)?$/, window.location.origin + '/bridge/assets/engine.swf'],
];
window.ClaudePenguinBridge = {
  receive(event) { window.dispatchEvent(new CustomEvent('claude-penguin-bridge', { detail: event })); },
};
