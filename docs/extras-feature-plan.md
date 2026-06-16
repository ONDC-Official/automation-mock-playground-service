# extraSequence / extraSteps — feature + flow-mapper refactor

## Context

Flow today has only one execution mode: a strict `flow.sequence` walked in order. Real ONDC traffic includes side-channel callbacks (e.g. an unsolicited `on_update`) that don't fit a fixed position in the strict flow. The `Flow` schema already declares an unused `extraSequence` field and `FlowMap` already declares an unused `extraSteps` array — scaffolding for a parallel-sub-flows model.

This change wires that scaffolding up. extraSequence entries are "flows within the flow": each entry has its own owner, its own pair (request/callback partner), and its own status that progresses independently of the main flow. The existing `flow-mapper.ts` (434-line single file with cascading helpers) is also refactored into a resolver-chain pattern so the new logic doesn't pile onto an already over-loaded function.

Outcome: incoming actions that currently land in `missedSteps` because they don't match the strict cursor will instead land in `extraSteps` when the action's type is declared in `extraSequence`. Pair partners auto-add as placeholders bound to the originating messageId. process-flow.ts dispatches a job for each actionable item across both sequence and extras in the same tick. Multiple concurrent extras sub-flows are tracked independently.

## Confirmed semantics (from user)

1. Match extras by `step.type` (= API action). Forms live only in strict sequence; extras are API-only.
2. extraSequence is **orthogonal** to MORE_SEQUENCE. MORE_SEQUENCE keeps its current strict-sequence-extension behavior.
3. Pair placeholder status: reuse existing `addPendingStep` logic (subscriber-vs-owner rules).
4. process-flow.ts acts on **all** actionable steps in one tick — sequence AND extras — dispatching one job per actionable.
5. Out-of-order strict actions **fall through to extras** if extras can match; only land in missedSteps if neither matches.
6. Duplicate `type` across extraSequence entries is a config error — **throw at construction**.
7. extras has its own status enum (AVAILABLE/WORKING/SUSPENDED) **per pair-instance** (keyed by anchor messageId), independent of the main `MockFlowStatusCache`. "Flow within a flow."

## File layout (final)

```
src/service/flows/
├── flow-mapper.ts                      # facade — re-exports old API + new getNextActions
├── flow-mapper.test.ts                 # existing 27 tests, untouched
├── process-flow.ts                     # multi-dispatch refactor
└── mapper/
    ├── flow-map-builder.ts             # FlowMapBuilder class (orchestrator)
    ├── reduce-history.ts               # reduceApiDataList + checkPerfectAck (extracted)
    ├── pending-step.ts                 # buildPendingStep(step, isImmediateNext, ...) → MappedStep[]
    ├── owner-utils.ts                  # deriveOwnerFromAction (on_ heuristic)
    ├── missed-step-factory.ts          # 3 missed-step builders
    └── resolvers/
        ├── resolver-types.ts           # ResolverContext, ResolverState, ResolverOutcome
        ├── sequence-resolver.ts        # strict-cursor match only (no out-of-order classification)
        ├── extras-resolver.ts          # NEW: type match + pair placeholder add/resolve
        └── missed-resolver.ts          # terminal: classifies out-of-order vs beyond vs unknown
```

`flow-mapper.ts` re-exports `getFlowCompleteStatus` and `getNextActionMetaData` so the existing test file's imports keep working unchanged.

## Resolver chain semantics

Per reduced+chronologically-sorted history event, dispatch in order:

```
sequenceResolver → extrasResolver → missedResolver
```

- **sequenceResolver**: consumes ONLY when `apiData.action === flowSequence[cursor].type`. Pushes a COMPLETE entry to `mappedFlow.sequence`, advances cursor. Anything else → not consumed.
- **extrasResolver**: consumes when `extrasByType.has(apiData.action)`. See §pair algorithm below.
- **missedResolver** (terminal, always consumes): classifies via `findStepInFlow(action, flowSequence, cursor)`:
  - Found at index `i > cursor` → "action executed out of order, expected at step i" (preserves current `missedStep.index = i`).
  - Else if `cursor >= flowSequence.length` → "action beyond flow sequence", `index = -1`.
  - Else → "action not found in flow sequence", `index = -1`.

Key behavioral shift vs. today: classification of "out of order" vs. "not found" moves from `sequenceResolver` into `missedResolver`. This is what lets extras intercept the out-of-order case (per user answer).

## Pair placeholder algorithm (extras-resolver)

State carried by `FlowMapBuilder`:
- `extrasByType: Map<string, SequenceStep>` — index for matching. Throws at construction if duplicate types detected.
- `extrasByKey: Map<string, SequenceStep>` — for resolving `pair` references.
- `pendingPlaceholders: Map<placeholderKey, indexInExtraSteps>` where `placeholderKey = ${expectedStep.key}::${awaitingMessageId}::${expectedStatus}`.

For each incoming API event matched in extras:

```
extraStep = extrasByType.get(apiData.action)

// First: try to resolve an existing placeholder for THIS step.
// (Means the pair fired earlier and registered this step as awaiting.)
matchKey = `${extraStep.key}::${apiData.messageId}`
if any pendingPlaceholders entry has prefix matchKey:
    // Resolve the first (or each, if dual-push quirk) placeholder.
    for each idx in matching entries:
        mappedFlow.extraSteps[idx].status = 'COMPLETE'
        mappedFlow.extraSteps[idx].payloads = apiData
        delete pendingPlaceholders entry
    return consumed:true

// Otherwise: add a fresh COMPLETE entry, plus placeholder for pair.
mappedFlow.extraSteps.push({
    status: 'COMPLETE',
    actionId: extraStep.key,
    owner: extraStep.owner,
    actionType: extraStep.type,
    input: extraStep.input,
    payloads: apiData,
    index: -1,
    unsolicited: extraStep.unsolicited,
    pairActionId: extraStep.pair,
    description: extraStep.description,
    label: extraStep.label,
    isExtraStep: true,
})

if extraStep.pair != null:
    pairStep = extrasByKey.get(extraStep.pair)
    if pairStep == null:
        log warning ("extras pair points at missing key"); return consumed:true
    // Avoid creating placeholder if pair already completed in earlier firing of same messageId
    if mappedFlow.extraSteps has COMPLETE entry with actionId=pairStep.key AND
       payloads.messageId == apiData.messageId:
        return consumed:true
    // Get the pair's status using same logic as strict-sequence pending pad.
    // The status uses extras-status (per pair-instance), NOT flow-status.
    extraStatus = lookupExtraStatus(transactionId, apiData.messageId)  // default AVAILABLE
    placeholders = buildPendingStep({
        step: pairStep,
        isImmediateNext: true,
        subscriberType,
        flowStatus: extraStatus,
    })
    for ph in placeholders:
        ph.isExtraStep = true
        ph.awaitingMessageId = apiData.messageId
        const idx = mappedFlow.extraSteps.length
        mappedFlow.extraSteps.push(ph)
        pendingPlaceholders.set(`${pairStep.key}::${apiData.messageId}::${ph.status}`, idx)

return consumed:true
```

Bidirectionality: works either direction because the algorithm checks "is there a placeholder awaiting THIS step's messageId" before falling through to the ADD path. Whichever side fires first creates the placeholder; the other side resolves it.

The `unsolicited && !input` dual-push quirk (documented in flow-mapper.test.ts:129) is preserved by having `buildPendingStep` return `MappedStep[]`. Each pushed placeholder gets its own entry in `pendingPlaceholders` keyed by status.

## Type changes

`src/types/mapped-flow-types.ts` — additive optional fields on `MappedStep`:

```typescript
awaitingMessageId?: string;   // set on extras pair placeholders only
isExtraStep?: boolean;        // marker for entries in extraSteps
```

New caller-facing type in `flow-map-builder.ts`:

```typescript
export interface NextActionMeta {
    sequenceNext?: MappedStep;
    extrasNext?: MappedStep[];   // ALL actionable extras placeholders (per pair-instance)
}

export function getNextActions(...): NextActionMeta;

// back-compat alias for existing tests
export function getNextActionMetaData(...): MappedStep | undefined {
    return getNextActions(...).sequenceNext;
}
```

## Extras status methods — extension to existing `FlowStatusCacheService`

Per user: extras need their own status independent of the main `MockFlowStatusCache`. Each in-flight dispatch instance has its own AVAILABLE/WORKING/SUSPENDED. **Implementation: add new methods to the existing `FlowStatusCacheService`** (do NOT create a parallel service).

New methods on the existing service (with a distinct Redis key prefix so it doesn't collide with main flowStatus):

- `getExtraFlowStatus(txId, subscriberUrl, extraStepKey)`
- `setExtraFlowStatus(txId, subscriberUrl, extraStepKey, status)`

Key shape: `extra-flow-status:${txId}:${subscriberUrl}:${extraStepKey}`. Lock granularity is `(transaction, extra step)` — only one in-flight dispatch per step per transaction. See "Lock key choice" below for why.

Used by:
- `extras-resolver` when computing placeholder status (`buildPendingStep` receives the extras status, not the main flow status).
- `process-flow.ts` when dispatching an extras job: sets the step's extras-status to WORKING before enqueue.
- **API service (out-of-repo, separate change)** writes AVAILABLE back to extras-status after it finishes processing — same protocol as the existing main `flowStatus` reset path. User has confirmed they will modify the api service to support this. The api service must know which `extraStepKey` to reset; it learns this from a field on the outgoing request payload (e.g. an `extraStepKey` context extension or header) that the mock job worker includes when `actionMeta.isExtraStep === true`.

### Lock key choice

Lock key is `(txId, subscriberUrl, extraStepKey)`, NOT messageId. Reason: messageId is generated by `mockRunner` inside the job, so for mock-initiated extras (e.g. mock dispatches an unsolicited `search`), we don't know the messageId at dispatch time. `extraStepKey` is known in both cases:

- **Event-driven case** (mock responds to an incoming extras event): the placeholder being dispatched corresponds to a specific extraSequence step; that step's key is the lock key.
- **Mock-initiated case** (mock dispatches the originating request): same — the extraSequence step we're about to fire provides the key.

Trade-off: only one in-flight dispatch per `(transaction, step)`. Multiple concurrent firings of the same step are not supported in v1; if a use case appears, lock granularity can be relaxed later (e.g. by adding an inputs-hash component to the key).

### Dispatch lifecycle

| step | actor | action |
|---|---|---|
| 1 | mock (`process-flow.ts`) | compute mappedFlow, find actionable extras placeholder |
| 2 | mock | `setExtraFlowStatus(txId, subscriberUrl, extraStepKey, 'WORKING')` |
| 3 | mock | enqueue `GENERATE_PAYLOAD_JOB` with `actionMeta` (`isExtraStep=true`, carrying `extraStepKey`) |
| 4 | job worker | `mockRunner` generates payload (incl. messageId), HTTP send to api service with `extraStepKey` embedded |
| 5 | api service | processes request, writes AVAILABLE back to `extra-flow-status:${txId}:${subscriberUrl}:${extraStepKey}` (new behavior) |

Duplicate `/proceed` between step 2 and step 5: mapper recomputes, the placeholder's pending status is computed against `extraStepKey`'s WORKING state → `PROCESSING`/`RESPONDING` (per `addPendingStep` rules), which is not in the dispatcher's "actionable" set → no re-dispatch.

Note: the `awaitingMessageId` on the pair's placeholder is unrelated to dispatch dedup — it's only used by `incoming-request-controller`'s callback matching once the response arrives. It is populated for event-driven extras (from the originating event's messageId) and for mock-initiated extras only after the dispatch job records the outgoing entry (or via subsequent reconciliation when the api service writes the apiList entry).

## Caller updates

### `src/service/flows/process-flow.ts`

Replace single-step dispatch with multi-step dispatch:

```typescript
const { sequenceNext, extrasNext } = getNextActions(
    params.transactionData, params.flow, flowStatus.status, businessCache
);

// Collect everything actionable for THIS subscriber.
const ownsActionable = (s: MappedStep) =>
    s.owner === params.transactionData.subscriberType &&
    (s.status === 'RESPONDING' || s.status === 'INPUT-REQUIRED' || s.status === 'WAITING-SUBMISSION');

const ownsListening = (s: MappedStep) =>
    s.owner === params.transactionData.subscriberType && s.status === 'LISTENING';

const targets: MappedStep[] = [];
if (sequenceNext && ownsActionable(sequenceNext)) targets.push(sequenceNext);
for (const x of extrasNext ?? []) if (ownsActionable(x)) targets.push(x);

// LISTENING expectation handled separately (single, sequence-only — extras don't expect).
```

For each target:
- If extras: `setExtraFlowStatus(..., target.awaitingMessageId, 'WORKING')` and enqueue `GENERATE_PAYLOAD_JOB` with `actionMeta: target`.
- If sequence: existing `setFlowStatus(..., 'WORKING')` and enqueue.

`ActionUponFlowResponse` extends to return `jobIds: string[]` instead of `jobId: string`.

Job-completion hooks in `src/service/jobs/generate-response.ts`: when the job's `actionMeta.isExtraStep` is true, on completion set extras-status back to AVAILABLE for that anchor messageId; otherwise hit the existing `setFlowStatus` reset path.

The `INPUT-REQUIRED + no inputs` early-return today blocks the whole call. With multi-dispatch, we'd still bail on missing inputs for sequence; extras paths don't take user inputs (extras are auto-driven), so the inputs check stays sequence-scoped.

### `src/controllers/incoming-request-controller.ts`

Two changes:

1. Search both lists:
   ```typescript
   const allSteps = [
       ...flowStatusComplete.sequence,
       ...(flowStatusComplete.extraSteps ?? []),
   ];
   const matchingStep = await findMatchingStep(allSteps, payload);
   ```

2. Guard the HTML_FORM follow-up (`processHtmlFormStep` lookahead on `nextStepIndex + 1`) against extras: skip when `matchingStep.step.isExtraStep === true`. Extras don't sit adjacent to form steps in the strict ordering.

`findMatchingStep` itself needs **no change** to its matching logic. By the time it runs:

- The api service has already written the incoming request into `transactionData.apiList` (existing protocol).
- `getFlowCompleteStatus` has already executed; the extras-resolver saw the new apiList entry, looked up the unresolved placeholder via the in-mapper `pendingPlaceholders` map, and mutated it in-place to `status: 'COMPLETE'` with `payloads = apiData`.
- The resolved placeholder now has the same `(action, messageId, timestamp)` shape on its `payloads` field as any sequence-side completed step.

So the existing payloads-based match key (`${data.action}::${data.messageId}::${data.timestamp}`) finds it without any extras-specific code path.

`MappedStep.awaitingMessageId` is retained as diagnostic metadata for placeholders (visible in `/current-status` while a sub-flow is in flight), but it is **not** used by `findMatchingStep`.

The mock runner's per-action `validate` / `save_data` configs must exist for extras action IDs too — out-of-scope plumbing concern, but flag during implementation.

### `src/controllers/flow-controller.ts`

No change. `sendSuccess(res, status)` already passes the full FlowMap; clients automatically see the new `extraSteps` array.

### `src/utils/flow-utils.ts`

No change. Per user: forms live only in strict sequence, so `getReferenceData` stays scoped to `flow.sequence`.

## Construction-time validation (FlowMapBuilder constructor)

Throw if:
- Two entries in `flow.extraSequence` share the same `type`.
- Any entry in `flow.extraSequence` has `type === 'HTML_FORM' || type === 'DYNAMIC_FORM' || type === 'HTML_FORM_MULTI'`.

Log warning (don't throw):
- `extraStep.pair` references a key not present in `extrasByKey`.
- Pair is asymmetric (A.pair = B but B.pair != A) — tolerated by design; one-direction pair resolution still works.

## Test plan

Existing 27 tests in `src/service/flows/flow-mapper.test.ts` must keep passing without edits. They will because:
- The facade re-exports `getFlowCompleteStatus` and `getNextActionMetaData` with their current signatures.
- When `flow.extraSequence` is omitted, extras resolver is a no-op and the chain reproduces today's behavior.
- The new `extraSteps` field is optional/empty, leaving existing `result.missedSteps`/`result.sequence` assertions intact.

New tests (appended to `flow-mapper.test.ts` or a new file under the same dir):

| ID | Scenario |
|---|---|
| E1 | empty extraSequence + unknown action → missedSteps (current behavior preserved) |
| E2 | extras match, no pair → one entry in extraSteps with COMPLETE, no missedStep |
| E3 | extras match with pair → COMPLETE entry + correctly-statused placeholder for pair |
| E4 | A fires, then B (pair) with same messageId → both COMPLETE in extraSteps, no orphans |
| E5 | B fires first, then A → bidirectional resolution works |
| E6 | Same extras key fires twice with different messageIds → two independent sub-flows |
| E7 | Out-of-order strict action that ALSO matches extras → lands in extraSteps (NOT missed) |
| E8 | Out-of-order strict action NOT in extras → stays in missedSteps with "out of order" |
| E9 | Pair points at missing key → COMPLETE entry pushed, warning logged, no placeholder |
| E10 | Action in both strict-cursor AND extras → strict consumes; extras gets nothing |
| E11 | extraSequence with duplicate type → constructor throws |
| E12 | extraSequence with HTML_FORM entry → constructor throws |
| E13 | `getNextActions` returns `{sequenceNext, extrasNext}`; placeholders surface in extrasNext |
| E14 | `getNextActionMetaData` (back-compat alias) still returns only sequenceNext |
| E15 | MORE_SEQUENCE + extras coexist → both work independently |
| E16 | extras-status set to WORKING → placeholder status becomes PROCESSING/RESPONDING |
| E17 | unsolicited && !input pair (BPP) → dual placeholder push; each independently resolvable |

## Migration phases (each phase commit-ready, tests green at end)

1. **Extract** (mechanical): move `reduceApiDataList`, `checkPerfectAck`, `addPendingStep`, owner heuristic, missed-step builders into `mapper/` files. `flow-mapper.ts` becomes a thin re-export shell. No behavior change.
2. **Resolverize**: introduce `FlowMapBuilder` + `sequenceResolver` + `missedResolver`. Existing tests pass.
3. **Extras**: add `MappedStep.awaitingMessageId/isExtraStep`, construction validations, `extrasResolver`, placeholder add/resolve. Add tests E1–E17.
4. **Next-action API**: add `getNextActions` returning `NextActionMeta`. Keep `getNextActionMetaData` alias.
5. **Extras status cache**: add `ExtraFlowStatusCacheService` to the WorkbenchCacheService and ServiceContainer. Wire `buildPendingStep` to consume it inside extras-resolver.
6. **process-flow multi-dispatch**: switch to multi-target dispatch; update `ActionUponFlowResponse.jobIds`; wire job-completion to extras-status reset.
7. **incoming controller**: update `findMatchingStep` + lookahead guards.

Each phase ends with `npm run lint`, `npm run type-check`, `npm test` clean.

## Verification

- `npm test` — all 27 existing tests + 17 new tests pass.
- `npm run type-check` — clean.
- `npm run lint` — clean (no new ESLint violations; `no-direct-response` rule not affected).
- Manual end-to-end:
  1. `npm run dev` to start the service.
  2. POST a flow config that includes an `extraSequence` with one pair (e.g. `extra-update`/`extra-on-update`).
  3. Start a transaction via `POST /flows/new`. Drive it past the first sequence step.
  4. Send an unsolicited `update` payload through the inbound webhook. `GET /flows/current-status` should show one entry in `extraSteps` with status COMPLETE plus one placeholder for `on_update` with status WAITING (or PROCESSING if extras-status was set WORKING by a job).
  5. Send the matching `on_update` with the same `messageId`. Status response now shows both extras entries COMPLETE.
  6. Confirm strict sequence pointer advanced independently — extras activity didn't disturb the strict cursor.

## Critical files

- `src/service/flows/flow-mapper.ts` — becomes facade.
- `src/service/flows/mapper/**` — new directory with extracted modules.
- `src/service/flows/process-flow.ts` — multi-dispatch + extras-status wiring.
- `src/controllers/incoming-request-controller.ts` — `findMatchingStep` + lookahead guard.
- `src/types/mapped-flow-types.ts` — `awaitingMessageId`, `isExtraStep` additive fields.
- `src/service/cache/extra-flow-status.ts` (new) — extras status cache.
- `src/container/implementations/main.ts` — register new cache service.
- `src/service/jobs/generate-response.ts` — completion hook resets extras-status when `actionMeta.isExtraStep`.
- `src/service/flows/flow-mapper.test.ts` — new tests appended (E1–E17).

## Unresolved questions

(none blocking — all earlier opens resolved)

### Resolved

- ~~Job-completion hook for extras-status reset~~ — api service will write AVAILABLE back, same protocol as main `flowStatus`. User confirmed they will modify the api service.
- ~~Should `incoming-request-controller` reset extras-status on callback?~~ — No. Reset is owned by the api service after it finishes processing the mock's outgoing request. The callback arrival just resolves the placeholder in mapped flow.
- ~~Extras status as new service or extension?~~ — Add methods to the existing `FlowStatusCacheService` with a distinct key prefix (`extra-flow-status:`). No new parallel service.
- ~~`ActionUponFlowResponse` shape `jobId → jobIds`?~~ — Yes, change to `jobIds: string[]`.
- ~~Mock-initiated extras dispatch dedup key~~ — Lock by `(txId, subscriberUrl, extraStepKey)`. messageId is only known after `mockRunner` runs, so it's not viable as the dispatch-time dedup key.
- ~~Asymmetric pair tolerance~~ — Tolerated; warn-only at construction time.
