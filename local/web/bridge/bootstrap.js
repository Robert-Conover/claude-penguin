// Only loaded on ?bridge=1, before Ruffle starts the preserved client.
window.RufflePlayer.config.urlRewriteRules = [
  [/^https?:\/\/[^/]+\/media\/play\/v2\/client\/engine\.swf(?:\?.*)?$/, window.location.origin + '/bridge/assets/engine.swf'],
  // Agent page only: Pet Shop adoption into project igloos (local/client-bridge/adoption_build.py).
  ...(window.CP_AGENT_MODE === true ? [[/^https?:\/\/[^/]+\/media\/play\/v2\/client\/puffle_adoption\.swf(?:\?.*)?$/, window.location.origin + '/bridge/assets/puffle_adoption.swf']] : []),
];
window.ClaudePenguinBridge = {
  receive(event) { window.dispatchEvent(new CustomEvent('claude-penguin-bridge', { detail: event })); },
};
