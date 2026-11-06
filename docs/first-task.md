# Give a puffle its first bug

A postcard from the Coffee Shop should say “Greetings from Coffee Shop!” This tiny Node.js project prints “Greetings from coffee shop!” instead. Give it to a puffle, visit Town, then check the fix in the puffle’s worktree. No package install or remote repository is needed.

## Make the postcards repo

With Git and Node.js 22+ on your Mac, paste this block into a terminal. It makes a new folder in your home directory, commits the example, and prints the path to enter in **Igloos**. The new directory stays around so you can resume the same project later.

```sh
(
  set -eu
  postcards=$(mktemp -d "$HOME/puffle-postcards.XXXXXX")
  cd "$postcards"
  git init -q
  cat > postcard.cjs <<'JS'
module.exports = room => `Greetings from ${room.toLowerCase()}!`;
JS
  cat > postcard.test.cjs <<'JS'
const test = require('node:test');
const assert = require('node:assert/strict');
const postcard = require('./postcard.cjs');

test('a postcard keeps the room name as written', () => {
  assert.equal(postcard('Coffee Shop'), 'Greetings from Coffee Shop!');
  assert.equal(postcard('Ski Hill'), 'Greetings from Ski Hill!');
});
JS
  git add -- postcard.cjs postcard.test.cjs
  git -c user.name='Puffle Postcards' -c user.email='postcards@example.invalid' \
    -c commit.gpgSign=false commit -qm 'Add the postcard and its failing test'
  printf 'Repository path: %s\n' "$PWD"
)
```

## Hand it to a puffle

1. [Start the game and the agent engine](../README.md#play-locally). Finish the introductory tour if it covers the controls, then open **Igloos → Add project**. Paste the printed path, replace the suggested project name with **Postcards**, and name its puffle **Pip** (or choose your own name).
2. **Visit** the igloo and click the puffle. Choose **Start / Resume**, then **Open Claude** to handle first-time folder trust. Return to the task card and send:

   > Run `node --test`. Fix the postcard so it preserves the room name. Leave the test unchanged, run it again, and tell me the result.
3. Close the card and walk to Town. **Work** reopens your selected puffle; if it needs permission, use **Open Claude** to review the request. Work continues while the host engine is running.
4. When the turn ends, open **Changes**. Look for the fix in `postcard.cjs`, with `postcard.test.cjs` unchanged. To check it yourself, use **Copy path**, then **Open Claude → Stop session** in the terminal footer. Run `node --test` in the copied worktree directory. Expect **1 passing test**. The original checkout should still have the failing version.

[Back to the island](../README.md)
