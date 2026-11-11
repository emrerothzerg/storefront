# server/qa

Product questions and answers with helpful votes (`qa-repository.ts`, `qa-service.ts`). Server-only: never import from a `"use client"` module. Owning task: T35 (programmer). Consumers: Q&A server actions (T47), QASection on the PDP, "Your contributions" in the account hub.

## Files

| File | Contents |
|---|---|
| `qa-repository.ts` | `QaRepository`, `SqliteQaRepository`, `NewQuestionRow`, `NewAnswerRow`, `VoteTarget`: thin SQL over `questions`, `answers`, `question_votes`, `answer_votes`; bound parameters only (id lists as one `json_each(?)` parameter); no business rules |
| `qa-service.ts` | `createQaService(deps)`, `getQaService()`, `QaService`, `QaServiceImpl`, `QaServiceDeps`, `QuestionView`, `AnswerView`, `QaListResult`, constants below |

App code uses `getQaService()` (globalThis singleton over `getDatabase()`, rebuilt if the shared database is reopened). Tests use `createQaService({ db, now?, newId? })` over `createDatabase(":memory:")` + `runMigrations` (+ `seedDatabase(db)` for seeded Q&A).

## Constants

`QA_PAGE_SIZE = 5`, `QUESTION_MIN_LENGTH = 10`, `QUESTION_MAX_LENGTH = 300`, `ANSWER_MIN_LENGTH = 1`, `ANSWER_MAX_LENGTH = 1000`, `DISPLAY_NAME_MAX_LENGTH = 50`, `MAX_ANSWERS_PER_QUESTION = 3`, `MAX_URLS_PER_POST = 2`, `DEFAULT_DISPLAY_NAME = "Anonymous shopper"`.

## Rules

- **Synchronous.** All methods are sync. Writes run read-then-write inside one `withTransaction` (BEGIN IMMEDIATE); a rule failure throws an internal `Abort` that rolls back and comes back as `Err`. Unexpected DB errors propagate (actions must catch and settle). `list` reads inside one DEFERRED transaction (consistent snapshot, no write lock).
- **Owner keys.** Every `sessionId` is an owner key (guest session or `users.owner_key`), validated with `isSessionId` before any query; invalid -> `INVALID_INPUT` (writes) or an empty result (`listMine`) / no viewer flags (`list`). The repository also guards: reads with a bad id return empty, writes throw `TypeError`.
- **No author keys in output.** Results are the domain `Question` / `Answer` types plus viewer-relative `isOwn` / `votedByViewer`. `session_id` is never selected into a returned object.
- **No store answers.** `is_store` is not a parameter anywhere; `insertAnswer` hard-codes `0`. Extra input keys such as `isStore` are ignored. Store answers exist only through the seed (or future admin tooling).
- **Text.** Bodies and display names go through `cleanText` (controls / invisibles stripped, whitespace collapsed, trimmed) and are then stored verbatim: HTML such as `<script>` is kept as typed and must be rendered as React text (SR3). Questions are single-line; answers keep line breaks (`multiline`). A missing (`undefined`/`null`) body counts as empty -> `VALIDATION_FAILED`; any other non-string -> `INVALID_INPUT`. More than 2 URL-like tokens (`countUrls`) -> `VALIDATION_FAILED` with `details.reason: "TOO_MANY_URLS"`.
- **Display name.** Optional; `undefined`, `null` or blank after cleaning -> `"Anonymous shopper"`; > 50 -> `TOO_LONG`. Field errors carry `details.field` (`"body"` or `"displayName"`) for form mapping.
- **Clock.** `now` is epoch ms. Per-call `now` (ask/answer) wins over `deps.now`, which defaults to `Date.now`. Stored `created_at` is `toISOString()`. A product is visible when `published_at <= now`.

## Methods

| Method | Behaviour | Errors |
|---|---|---|
| `ask(s, { productId, body, displayName? }, now?)` | Inserts a published question (`helpfulCount` 0). Validation order: session, body, display name, product, duplicate. | `INVALID_INPUT`, `VALIDATION_FAILED` (< 10 after cleaning, URL spam), `TOO_LONG` (> 300; name > 50), `PRODUCT_NOT_FOUND` (unknown, unpublished, non-string id), `DUPLICATE` (same cleaned text, exact match, same session, same product; hidden earlier questions count) |
| `answer(s, { questionId, body, displayName? }, now?)` | Inserts a community answer (`isStore: false`). A session may answer its own question. | `INVALID_INPUT`, `VALIDATION_FAILED` (empty, URL spam), `TOO_LONG` (> 1000; name > 50), `NOT_FOUND` (unknown or hidden question, or its product unpublished), `LIMIT_REACHED` (session already has 3 answers on this question, hidden ones included; `details.limit`) |
| `voteQuestion(s, id)` / `voteAnswer(s, id)` | One helpful vote per session per target (`INSERT ... ON CONFLICT DO NOTHING`; triggers keep `helpful_count`). Returns the fresh `{ helpfulCount }`. | `INVALID_INPUT`, `NOT_FOUND` (unknown/hidden target; for answers also a hidden question), `FORBIDDEN` (own content), `DUPLICATE` (already voted; the contract uses `DUPLICATE`, not `ALREADY_VOTED`) |
| `list(productId, { page? }?, viewer?)` | Published questions: `helpful_count DESC, created_at DESC, id DESC`; nested published answers: `is_store DESC, helpful_count DESC, created_at DESC, id DESC`. 5 per page. `page` that is not a safe integer >= 1 -> 1; past the end -> last page. `pageCount = max(1, ceil(total / 5))` (an empty product is page 1 of 1). With a valid viewer every question/answer gets `isOwn` and `votedByViewer`; without one those keys are absent. | `PRODUCT_NOT_FOUND` (unknown or unpublished) |
| `count(productId)` | Published questions on the product; 0 for unknown. | — |
| `listMine(s)` | The session's own questions and answers, any status (so "hidden" can be shown), newest first. Questions carry no `answers`. Invalid session -> empty lists. | — |
| `listMineWithAnswers(s)` | (`OwnQaReader`, consistency an; on the object `createQaService`/`getQaService` return, not on the `QaService` interface so existing fakes compile.) Own questions (any status, newest first) as `QuestionView` with `isOwn: true` and nested answers: every published answer in `list()` order, then the owner's own unpublished answers; answers carry `isOwn`/`votedByViewer`. Own answers (any status, newest first) as `OwnAnswerView` = answer + `question` (any status; `question.productId` names the product). One deferred read transaction. Invalid session -> empty lists, no SQL. | — |

## Rate limiting

Not done here. Actions call the T31 limiter first (ask 5/h, answer 10/h, votes 60/h per session, plus global backstops).
