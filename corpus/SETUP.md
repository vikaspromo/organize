# Email Corpus OAuth Setup (one-time, ~20 min)

Goal: a **durable, read-only** Gmail credential on this machine so `sync-corpus.mjs` can pull emails tagged with the `!organize` label. Everything stays local; nothing is pushed.

> **Scope is defined by the `!organize` Gmail label.** `CORPUS_QUERY` in `sync-corpus.mjs` selects all mail tagged with this label, including messages in Trash/Spam (in:anywhere ensures deleted/filtered messages are not silently absent — otherwise a moved message disappears with no trace, and the record-check reads that absence as "never received").

> **Why these specific choices:** read-only scope (least privilege) · Desktop-app client (loopback auth, no server) · **Production publishing status** (Testing status expires refresh tokens after 7 days — Production does not).

## Prereq
- Node installed (`node --version`)
- The `!organize` Gmail label created in your Gmail account (create it if you haven't already)

## 1. Create a Google Cloud project
> **One per machine.** If you already have the `divorce` Google Cloud project (from the coparenting repo), you can reuse it — OAuth clients are independent and don't conflict. If not, create a new one.

1. Go to <https://console.cloud.google.com> → project picker → **New Project** → name it → Create.
2. Make sure that project is selected.

## 2. Enable the Gmail API
1. APIs & Services → **Library** → search "Gmail API" → **Enable**.

## 3. Configure the OAuth consent screen (new "Google Auth Platform" layout)
Google revamped this into tabs (Overview / Branding / Audience / Clients / Data Access). The pieces are spread across tabs, not a linear wizard:
1. **Branding** — set app name `corpus-sync` + your support email (vikassood@gmail.com).
2. **Audience** — User type **External**; then **Publish app → Production**. *(This is the one that matters — Production avoids the 7-day refresh-token expiry. Unverified is fine; you're the only user, and you'll click through one "Google hasn't verified this app" warning during auth.)*
3. **Data Access** *(optional)* — "Add or remove scopes" → filter `gmail.readonly` → add → Save. **You can skip this** — `auth.mjs` requests `gmail.readonly` at runtime, so consent includes it regardless. Pre-listing scopes only matters for Google's verification process, which we're not doing.

## 4. Create the OAuth client
1. APIs & Services → **Credentials** → Create credentials → **OAuth client ID**.
2. Application type: **Desktop app** → name it → Create.
3. **Download JSON.** Save it as **`corpus/credentials.json`** (gitignored automatically).

### 4a. Re-downloading the secret for an *existing* client
If `credentials.json` is lost (e.g. the working dir was clobbered — the whole `corpus/` data zone is gitignored, so nothing is recoverable from git), **you do not need a new client.** The secret stays downloadable for the life of the client:

1. Google Auth Platform → **Clients** → click the client name.
2. Click the **ⓘ (Additional information)** icon, top right of the detail pane.
3. Under **Client secrets**, use the **download (⤓)** icon next to the masked secret.
4. Move it into place and lock it down:
   ```
   mv ~/Downloads/client_secret_*.json corpus/credentials.json && chmod 600 corpus/credentials.json
   ```

**The list view is misleading:** the Actions column shows only edit/delete, with no download icon. That absence is *not* evidence the secret is gone — it lives one level down, behind the ⓘ panel. Reading it as "unrecoverable" leads to creating a redundant client and an orphaned live credential.

Then re-run §5 (`node corpus/auth.mjs`) — a new client, or a re-downloaded secret, always needs a fresh consent round.

## 5. Authorize (run the auth script once)
```
node corpus/auth.mjs
```
- It opens your browser to Google's consent page. Sign in as **vikassood@gmail.com**.
- On "Google hasn't verified this app," click **Advanced → Go to corpus-sync (unsafe)** — safe here; it's your own app.
- Grant the **read-only Gmail** access.
- The script catches the redirect, exchanges it for a **refresh token**, and writes `corpus/token.json` (gitignored). You should see `✓ Refresh token saved`.

## 6. First sync (full backfill)
```
node corpus/sync-corpus.mjs
```
First run pulls everything tagged with `!organize` into `corpus/store/`. Later runs fetch only new mail — the `.sync-state.json` cursor (`maxInternalSec`) adds an `after:` clause.

**Writes are additive and id-deduped**, so a full re-list never re-downloads anything. That makes widening the query safe: to backfill history after adding emails to the label, just re-run and only genuinely new messages download. Note the cursor rewrites to `0` if that run fetches nothing — restore it from the newest indexed message rather than leaving it, or every later sync re-lists the whole corpus.

---
After step 6 runs clean, you have a working corpus. Run `node corpus/parse-corpus.mjs` to index and classify the emails.
