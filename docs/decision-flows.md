# Decision Flows Reference

> Branch maps for every HTTP entry point, state machine, job, and cache in `automation-mock-playground-service`. Reference-style, terse. File:line citations on every claim. Last reviewed: 2026-05-27.

## Contents

1. [At-a-glance](#1-at-a-glance)
2. [HTTP entry points](#2-http-entry-points)
3. [Middleware branches](#3-middleware-branches)
4. [Controllers (per endpoint)](#4-controllers-per-endpoint)
5. [process-flow dispatch matrix](#5-process-flow-dispatch-matrix)
6. [Flow mapper & resolver chain](#6-flow-mapper--resolver-chain)
7. [Extras sub-flow lifecycle](#7-extras-sub-flow-lifecycle)
8. [MappedStep status truth table](#8-mappedstep-status-truth-table)
9. [State machines](#9-state-machines)
10. [Form variants](#10-form-variants)
11. [Job pipelines](#11-job-pipelines)
12. [Cache layer reference](#12-cache-layer-reference)
13. [Error codes & exceptions](#13-error-codes--exceptions)
14. [Cross-cutting](#14-cross-cutting)

---

## 1. At-a-glance

Mental model: an ONDC test harness that **simulates the other party** to a subscriber-under-test. Each transaction has a strict `flow.sequence` plus an optional set of parallel `extraSequence` sub-flows. State is materialised on every read by `getFlowCompleteStatus` (`flow-mapper.ts:23-34`) — there is no persistent "current step pointer"; instead the mapper replays apiList through a resolver chain to compute current state.

Two concurrent state machines guard dispatch:

```
flowStatus        : AVAILABLE | WORKING | SUSPENDED   (per transaction, gates strict sequence)
extraFlowStatus[] : AVAILABLE | WORKING | SUSPENDED   (per (transaction, extra step), gates that extra placeholder)
```

Plus a 7-value `MappedStep.status` ({COMPLETE, LISTENING, RESPONDING, WAITING, INPUT-REQUIRED, PROCESSING, WAITING-SUBMISSION}) computed from the (step, subscriber-vs-owner, flowStatus, has-input, unsolicited) tuple.

Architecture:

```
                          ┌─────────────────────────────┐
                          │   external api-service      │ ◄── writes apiList,
                          │   (separate process)        │     forwards requests
                          └────────┬────────────────────┘
                                   │ HTTP
                                   ▼
HTTP request  ──►  middleware  ──►  controller  ──►  service  ──►  IQueueService.enqueue
                                                          │              │
                                                          ▼              ▼
                                                   WorkbenchCache    in-memory queue
                                                   (Redis DB 0)      or RabbitMQ
                                                                          │
                                                                          ▼
                                                                    job handler
                                                                          │
                                                                          ▼
                                                                   HTTP → api-service
```

All business routes mount under `/mock/playground` (`server.ts:62`). Ops endpoints (`/health`, `/metrics`, `/memory`, `/heapdump`) are app-root (`server.ts:24-50`).

---

## 2. HTTP entry points

Mounting: `server.ts:62` mounts `router` (`routes/index.ts`) at `/mock/playground`. Sub-routers in `routes/index.ts:9-12`:

| Sub-router | Path prefix | File |
|---|---|---|
| `manualRouter` | `/manual` | `routes/manualRoutes.ts` |
| `flowRouter` | `/flows` | `routes/flowRoutes.ts` |
| `backdoorRouter` | `/backdoor` | `routes/backdoorRouter.ts` |
| `formRouter` | `/forms` | `routes/formRoutes.ts` |

### Endpoint index

| Method | Path | Handler pipeline | Defined in |
|---|---|---|---|
| POST | `/mock/playground/flows/new` | `startNewFlowController` → `actUponFlow` | `flowRoutes.ts:15-19` |
| POST | `/mock/playground/flows/proceed` | `proceedWithFlowController` → `actUponFlow` | `flowRoutes.ts:21-25` |
| GET | `/mock/playground/flows/current-status` | `validateRequiredParams(['transaction_id', 'session_id'])` → `getFlowStatusController` | `flowRoutes.ts:27-31` |
| POST | `/mock/playground/manual/:action` | `receivePayloadFromApiService` → `validateAndSaveIncomingRequest` → `actUponFlow` | `manualRoutes.ts:27-31` |
| GET | `/mock/playground/forms/:domain/:formId` | `getFormController` | `formRoutes.ts:14` |
| POST | `/mock/playground/forms/:domain/:formId/submit` | `submitFormController` | `formRoutes.ts:15-18` |
| DELETE | `/mock/playground/backdoor/clear-flows` | `clearFlowsController` | `backdoorRouter.ts:26-29` |
| GET | `/health` | inline (`server.ts:43-58`) | n/a |
| GET | `/metrics` | inline (`server.ts:24-27`) | n/a |
| GET | `/memory` | inline (`server.ts:30-33`) | n/a |
| GET | `/heapdump` | inline (`server.ts:36-39`) | n/a |

---

## 3. Middleware branches

### 3.1 `requestLogger` / `responseLogger` (`middlewares/http-logger.ts`)

`SKIP_PATHS = ['/health', '/metrics', '/memory', '/heapdump']` (`http-logger.ts:4`).

| Branch | File:line | Effect |
|---|---|---|
| URL prefix matches SKIP_PATHS | `http-logger.ts:8-11`, `:59`, `:70` | bypass log, `next()` |
| Else, request | `http-logger.ts:61` | log `[METHOD] RequestLog=> URL`, `next()` |
| Else, response | `http-logger.ts:73-78` | wraps `res.send` to log status + body, original send invoked |

`responseLogger` body summarisation: `LOG_FULL_RESPONSE === 'true'` → full body; else if size > 2048 bytes → preview first 500 chars (`http-logger.ts:38-51`).

### 3.2 `validateRequiredParams` (`middlewares/validateParams.ts`)

Factory returning middleware (`validateParams.ts:6-19`).

| Branch | File:line | Effect |
|---|---|---|
| Any param in `params` array missing from `req.query` | `validateParams.ts:8-14` | `next(new httpValidationError('Missing required parameters', params))` |
| All present | `:17` | `next()` |

### 3.3 `requireJsonContent` (`middlewares/http-validations.ts`)

Note: defined but **not currently wired** into `server.ts`. Documented for completeness.

| Branch | File:line | Effect |
|---|---|---|
| `req.method !== 'POST'` | `http-validations.ts:10-12` | `next()` (skip) |
| POST AND `content-type !== 'application/json'` | `:17-22` | `sendError('BAD_REQUEST', 'Content-Type must be application/json')` — 400 |
| POST AND content-type ok | `:24` | `next()` |

### 3.4 `globalErrorHandler` (`middlewares/error-handler.ts`)

Mounted last (`server.ts:65`). Cascading instanceof checks.

| Branch | File:line | Effect | HTTP |
|---|---|---|---|
| `res.headersSent` | `:25-26` | `next(err)` (no response) | — |
| `isBodyParserJsonError(err)` | `:29-33` | `sendError('BAD_REQUEST', 'Invalid JSON...')` | 400 |
| `err instanceof httpValidationError` | `:36-42` | `sendError('BAD_REQUEST', err.message, {details})` | 400 |
| `err instanceof InternalServerError` | `:43-45` | `sendError('INTERNAL_ERROR', err.message)` | 500 |
| `err instanceof OndcProtocolError` | `:47-49` | `sendNack(res, becknContext, err.code, err.customMessage)` | 200 (NACK envelope) |
| Any other Error | `:50` | `sendError('INTERNAL_ERROR')` | 500 |

---

## 4. Controllers (per endpoint)

### 4.1 `POST /flows/new` — `startNewFlowController` (`flow-controller.ts:87-151`)

Attaches a fresh `FlowContext` to the request, then `actUponFlow` runs. No transaction lookup (this creates a transaction).

| Branch | File:line | Effect |
|---|---|---|
| Body fails `startNewFlowBodySchema` | `:93-97` via `validateOrThrow` | throw → `next(normalizeError(err, OndcProtocolError('31001','Error starting new flow','Unknown error')))` → handler maps to NACK |
| `body.transaction_id` absent | `:99` | generate `randomUUID()` |
| `sessionData` missing for `body.session_id` | `:101-109` | throw `InternalServerError('Session not found: ...')` → 500 INTERNAL_ERROR |
| `fetchFlow(sessionData, body.flow_id)` throws (no such flow) | `:111` see `utils/flow-utils.ts:7-19` | propagates → normalised to OndcProtocolError('31001') |
| Happy path | `:113-137` | `attachFlowContext(req, {...})` then `next()` → falls through to `actUponFlow` |

### 4.2 `POST /flows/proceed` — `proceedWithFlowController` (`flow-controller.ts:153-217`)

| Branch | File:line | Effect |
|---|---|---|
| Body fails `proceedWithFlowBodySchema` | `:159-163` | throw → normalizeError → OndcProtocolError('31001','Error proceeding with flow') |
| Session missing | `:165-173` | `InternalServerError('Session not found: ...')` → 500 |
| Transaction missing (cache throws inside `getTransactionData`) | `:175-186` see `workbench-cache.ts:28-40` | InternalServerError or propagated → 500 |
| Happy path | `:188-203` | attach FlowContext (includes `inputs`, `use_inputs_extra` is **not** wired through — see §5.5 caveat) and `next()` |

### 4.3 `GET /flows/current-status` — `getFlowStatusController` (`flow-controller.ts:219-289`)

Pure read endpoint. Returns the full `FlowMap` from the mapper.

| Branch | File:line | Effect |
|---|---|---|
| `validateRequiredParams(['transaction_id','session_id'])` blocks | (middleware) | 400 BAD_REQUEST via globalErrorHandler |
| Query fails `getFlowStatusQuerySchema` | `:226-230` | OndcProtocolError('31001','Error fetching flow status') |
| Session missing | `:236-240` | InternalServerError → 500 |
| Transaction lookup throws | `:244-246` | propagates → 500 |
| Happy path | `:269-275` | `sendSuccess(res, FlowMap)` — `{sequence, missedSteps, extraSteps, reference_data}` |

### 4.4 `POST /manual/:action` — three-stage pipeline (`manualRoutes.ts:27-31`)

#### Stage A: `receivePayloadFromApiService` (`flow-controller.ts:37-85`)

Loads transaction (apiList already written by api-service before forwarding), attaches FlowContext.

| Branch | File:line | Effect |
|---|---|---|
| `transactionData.sessionId` absent | `:51-55` | `InternalServerError('Session ID not found in transaction data')` → 500 |
| `getTransactionData` throws (no such txn) | `:46-48` | propagated → normalizeError → OndcProtocolError('31001','Error receiving payload...') |
| Happy path | `:60-71` | attach FlowContext, `next()` |

#### Stage B: `validateAndSaveIncomingRequest` (`incoming-request-controller.ts:37-119`)

| Branch | File:line | Effect |
|---|---|---|
| No FlowContext | `:43-47` | throw `InternalServerError('[DEFECT] Flow context is missing in the request')` |
| `findMatchingStep(combined, payload)` returns null | `:78-85` | log warning, `next()` — continues to actUponFlow (no ACK, no dispatch) |
| Validation fails (`!validationResult.valid`) | `:239-253` see `processMatchingRequest` | `handleValidationFailure` enqueues error reply via `SEND_TO_API_SERVICE_JOB`; `shouldRespond: true` → `sendAck(res, payload.context)` (200 ACK) and return — **does NOT proceed to actUponFlow** |
| HTML_FORM lookahead absent (no form next or step is extras) | `:275-302` | `shouldRespond: false` → `next()` → actUponFlow |
| HTML_FORM lookahead present + URL missing | `:373-379` | warn, `shouldRespond: false` → `next()` |
| HTML_FORM URL fetch returns invalid HTML (`validateFormHtml` rejects) | `:385-403` | enqueue error form-job; `shouldRespond: true` → ACK and return |
| HTML_FORM URL fetch + validate OK | `:406-419` | rewrite form actions, overwrite session, `shouldRespond: false` → next() |
| Any thrown exception inside `processMatchingRequest` | `:305-312` | log, return `{shouldRespond: false}` (continues to actUponFlow) |
| Catch-all in outer try | `:105-117` | `next(normalizeError(err, OndcProtocolError('31001','Error acting upon flow','Unknown error')))` |

`findMatchingStep` (`incoming-request-controller.ts:122-149`): walks combined (sequence ∪ extraSteps), matches on `${data.action}::${data.messageId}::${data.timestamp}` against `body.context`. Skips entries where `payloads` is null/FORM/HTML_FORM. Extras placeholders resolved by mapper already carry payloads — no special matching path needed (see §7.4).

#### Stage C: `actUponFlow` (`flow-controller.ts:291-322`)

| Branch | File:line | Effect |
|---|---|---|
| FlowContext missing | `:296` via `assertFlowContext` | InternalServerError → 500 |
| `processFlow(...)` throws | `:309-321` | normalised to OndcProtocolError('31001','Error acting upon flow') |
| Happy path | `:307` | `sendSuccess(res, result, true)` — 200 with `ActionUponFlowResponse` |

### 4.5 `GET /forms/:domain/:formId` — `getFormController` (`form-controller.ts:25-94`)

| Branch | File:line | Effect |
|---|---|---|
| `domain` or `formId` is array (param polyfill quirk) | `:33-35` | `throw new Error('Invalid parameters')` → next(error) → 500 |
| Query fails `getFormQuerySchema` | `:36-40` | propagates to next(error) |
| `sessionData` missing | inside `:41-43` cache throws | next(error) → 500 |
| `transactionData` missing | `:44-49` cache throws | next(error) → 500 |
| `runnerConfig`/`stepConfig` missing | `:50-57` | next(error) |
| No `Accept` header | `:60-69` | `preferHtml = false`, log |
| `Accept` header → `req.accepts(['html','json']) === 'html'` | `:71` | `preferHtml = true` |
| `handleGetFormService` returns `dataType: 'json'` | `:81-84` | `sendSuccess(res, data)` |
| Returns `dataType: 'html'` | `:85-88` | `res.type('html').send(data)` |
| Invalid `dataType` | `:89` | throw → next(error) |

`handleGetFormService` (`form-handlers.ts:12-60`):
- `stepConfig.api` neither `dynamic_form` nor `html_form` → throw (`:20-22`)
- `dynamic_form` + `!direct && !preferHtml` → return `{dataType:'json', data:{success, type:'dynamic', formUrl, message}}` (`:23-36`)
- Else decode base64 form HTML and render via EJS with `actionUrl`+`submissionData` (`:40-59`)

### 4.6 `POST /forms/:domain/:formId/submit` — `submitFormController` (`form-controller.ts:95-157`)

Same parameter-validation pattern. `handleFormSubmitService` (`form-handlers.ts:62-139`) is the interesting body:

| Branch | File:line | Effect |
|---|---|---|
| `stepConfig.api` invalid | `:72-74` | throw |
| Always | `:75-76` | generate `submissionID = randomUUID()`, attach to `formData` |
| Either `dynamic_form` or `html_form` | `:77-122` | persist via `updateSessionWithFormSubmission` + `addFormData`, then call `actOnFlowService(...inputs: {submission_id})` |
| After `actOnFlowService`, `html_form` | `:114-122` | return `{dataType:'json', data:{success, submission_id}}` |
| After `actOnFlowService`, `dynamic_form` | `:123-128` | return `{dataType:'html', data: successHtml}` (animated success page) |
| Else (unreachable given guard) | `:129-138` | return JSON success |

### 4.7 `DELETE /backdoor/clear-flows` — `clearFlowsController` (`backdoor-controller.ts:9-43`)

| Branch | File:line | Effect | HTTP |
|---|---|---|---|
| `clearFlowsQuerySchema.safeParse(req.query)` fails | `:15-24` | `next(new httpValidationError(...))` → 400 |
| `backdoorService.clearFlowCache(data)` throws | `:31-42` | `sendError('INTERNAL_ERROR', 'Failed to clear flow cache', {error})` — 500 |
| Happy path | `:26-30` | `sendSuccess(res, result)` — 200 |

Query schema accepts: `domain` (required), `version` (optional), `flowId` (optional). See `types/backdoor-types.ts`.

### 4.8 Ops endpoints

| Endpoint | File:line | Branches |
|---|---|---|
| `/health` | `server.ts:43-58` | `healthMonitor.getHealthStatus()` throws → `sendError('HEALTH_CHECK_FAILED')` 503; else 200 |
| `/metrics` | `:24-27` | always 200 Prometheus text format |
| `/memory` | `:30-33` | always 200 `sendSuccess(res, collectMemorySnapshot())` |
| `/heapdump` | `:36-39` | writes file via `takeHeapSnapshot('heap-dumps')`, returns 200 `{file}` |

---

## 5. process-flow dispatch matrix

`actOnFlowService` (`process-flow.ts:32-211`) decides what jobs to enqueue this call. Multi-target dispatch — both sequence and extras can fire in one tick.

### 5.1 Early exits

| Condition | File:line | Outcome |
|---|---|---|
| `flowStatus === 'SUSPENDED'` | `:48-53` | `{success:false, message:'Flow is suspended...'}` |
| No `sequenceNext` AND no `extrasNext[]` | `:77-82` | `{success:true, message:'No further action required'}` |

### 5.2 Inputs routing — `use_inputs_extra` flag

Caller decides which side consumes `params.inputs`:

| `use_inputs_extra` | Effect |
|---|---|
| `false` / undefined (default) | inputs go to sequence target if any; extras placeholders ignore inputs |
| `true` | inputs go to FIRST `INPUT-REQUIRED` extras placeholder; sequence ignores inputs |

Implementation: `useInputsForExtras` flag at `process-flow.ts:84`, gates per-target `consumesInputs` bool that flows through to `dispatchTarget`.

### 5.3 Per-side gating

#### Sequence side (`:94-113`)

| Condition | Effect |
|---|---|
| `flowStatus !== 'AVAILABLE'` (e.g. WORKING) | seq not dispatched (sequence is locked) |
| `sequenceNext.status` not in `{RESPONDING, INPUT-REQUIRED, WAITING-SUBMISSION}` | not a dispatch target |
| Status=INPUT-REQUIRED + `useInputsForExtras` OR no `inputs` | seq stalls (`sequenceAwaitingInputs`) |
| Status=INPUT-REQUIRED + inputs present + `!useInputsForExtras` | dispatched, consumes inputs |
| Status=RESPONDING/WAITING-SUBMISSION | dispatched; consumes inputs only if `!useInputsForExtras && hasInputs` |

#### Extras side (`:115-132`)

Loop over `extrasNext` placeholders. Each is gated by **its own** `extraFlowStatus`:

| Condition | Effect |
|---|---|
| `extraFlowStatus[step.actionId] !== 'AVAILABLE'` | skip this placeholder (sub-flow already in flight) |
| Status not in DISPATCH_STATUSES | skip |
| Status=INPUT-REQUIRED + `useInputsForExtras` + inputs + first such | dispatched, consumes inputs (subsequent INPUT-REQ extras stall) |
| Status=INPUT-REQUIRED + (no inputs OR `!useInputsForExtras` OR not first) | stall (`extrasAwaitingInputs`) |
| Status=RESPONDING/WAITING-SUBMISSION | dispatch with `consumesInputs=false` |

### 5.4 Outcomes after dispatch loop

| Condition | File:line | Response |
|---|---|---|
| `sequenceAwaitingInputs` OR `extrasAwaitingInputs[]` non-empty | `:147-169` | success, message lists awaiting steps; `inputs` schema = seq-awaiting (preferred) else first extras-awaiting; `jobIds` if any dispatched |
| 0 jobs + `sequenceNext.status === 'LISTENING' && .expect && sessionId` | `:173-189` | `createExpectation(subscriberUrl, flowId, sessionId, actionType)` → `'Mock Service is now listening for the next action'` |
| 0 jobs + main `flowStatus === 'WORKING'` | `:191-195` | `{success:false, 'Flow is already being processed'}` |
| 0 jobs (nothing actionable for this subscriber) | `:197-200` | `{success:true, 'No actionable step for this subscriber'}` |
| Jobs dispatched | `:203-210` | `{success:true, jobIds, message:'server is now responding...' or 'dispatched N jobs'}` |

### 5.5 `dispatchTarget` (`process-flow.ts:235-314`)

| Step | File:line | Action |
|---|---|---|
| 1. Status to WORKING | `:245-262` | If `target.isExtraStep` → `setExtraFlowStatus(txId, subUrl, actionId, 'WORKING')` (`:248`); else → `setFlowStatus(...,'WORKING')` (`:257`) |
| 2a. Form path (`FORM_TYPES.has(target.actionType)`) | `:264-296` | require `inputs.submission_id` (else throw); `addFormSubmissionId(...)`; enqueue `API_SERVICE_FORM_REQUEST_JOB` (`:296`) |
| 2b. API path | `:299-313` | if `consumesInputs` write `businessCache.user_inputs = inputs` (`:301`); enqueue `GENERATE_PAYLOAD_JOB` (`:313`) with `actionMeta`+`inputs:(consumesInputs ? inputs : undefined)` |

### 5.6 Caveats

- **`use_inputs_extra` not yet wired through controllers**: `FlowContext.use_inputs_extra` is read by `actOnFlowService` (`:84`) but neither `startNewFlowController` (`:113-133`) nor `proceedWithFlowController` (`:190-201`) populate it from the request body. Plumbing extension needed when this is actually used.
- **Multiple extras INPUT-REQUIRED**: only the FIRST such placeholder consumes inputs; subsequent ones stall (`process-flow.ts:121-128`). Worth noting in operator docs.
- **`businessCache.user_inputs` write**: now gated by `consumesInputs` (`:284-286`). If neither side consumes, no stale write happens.

---

## 6. Flow mapper & resolver chain

`FlowMapBuilder` (`mapper/flow-map-builder.ts`) is constructed per request and builds the `FlowMap` via a resolver chain.

### 6.1 Resolver chain

```
sequenceResolver → extrasResolver → missedResolver
```

`mapper/flow-map-builder.ts:62-66`. Iteration: for each reduced+sorted apiList entry, resolvers run in order; first to return `{consumed:true}` wins.

| Resolver | File | Consumes when | Effect |
|---|---|---|---|
| `sequenceResolver` | `mapper/resolvers/sequence-resolver.ts` | `apiData.action === flowSequence[cursor].type` (or formType match) | push COMPLETE entry to `mappedFlow.sequence`, advance cursor |
| `extrasResolver` | `mapper/resolvers/extras-resolver.ts` | `extrasByType.has(apiData.action)` (API entries only) | RESOLVE pair placeholder OR ADD fresh COMPLETE + placeholder (§7) |
| `missedResolver` | `mapper/resolvers/missed-resolver.ts` | always consumes (terminal) | classify into one of 3 missed kinds (§6.2) |

### 6.2 Missed classification (`missed-resolver.ts:5-62`)

| Condition | Description placed on missed step | `index` |
|---|---|---|
| `cursor >= flowSequence.length` | `"action beyond flow sequence"` / `"form beyond flow sequence"` | -1 |
| `findStepInFlow(action, sequence, cursor) === i` (i > cursor) | `"action executed out of order - expected at step i, but step cursor not completed"` (similar for form) | i |
| Else | `"action not found in flow sequence"` / `"form not found in flow sequence"` | -1 |

Helper: `findStepInFlow` at `mapper/sequence-lookup.ts:3-12`.

### 6.3 Pending-step padding

After history is consumed, unmapped strict-sequence steps get padded as pending (`flow-map-builder.ts:94-105`). `buildPendingStep` (`mapper/pending-step.ts:13-86`) returns `MappedStep[]` (can be 1 or 2 entries — see §8 dual-push).

### 6.4 Construction-time validation

`createExtrasIndex(extraSequence)` (`extras-resolver.ts:18-39`) throws:

| Condition | Error |
|---|---|
| `step.type` is HTML_FORM / DYNAMIC_FORM / HTML_FORM_MULTI | `"extraSequence entry "{key}" has form-type "{type}"; forms must live only in strict sequence"` |
| Two entries share `step.type` | `"extraSequence has duplicate type "{type}" (keys: "{a}" and "{b}")"` |

Missing pair key reference is **tolerated** at runtime (extras-resolver.ts:100-103): pushes the COMPLETE entry without creating a placeholder; asymmetric pair handled the same way.

### 6.5 MORE_SEQUENCE composition

`flow.sequence` is extended at construction by `mockSessionData.MORE_SEQUENCE` (`flow-map-builder.ts:43-44`). MORE_SEQUENCE is orthogonal to `extraSequence` — it makes additional steps strict, not parallel.

---

## 7. Extras sub-flow lifecycle

`extras-resolver.ts:45-144`. Per matched apiData, two paths: ADD or RESOLVE.

### 7.1 Index construction

Constructor (`extras-resolver.ts:18-39`) builds two Maps:

| Map | Key | Value |
|---|---|---|
| `byType` | `step.type` (API action) | the `SequenceStep` |
| `byKey` | `step.key` (uniq id) | the `SequenceStep` |

### 7.2 RESOLVE path (`:66-78`)

If `pendingPlaceholders.get(`${extraStep.key}::${apiData.messageId}`)` returns indices, the pair already fired earlier and registered a placeholder for THIS step:

1. For each idx in the list, mutate `mappedFlow.extraSteps[idx]` → `status='COMPLETE'`, `payloads=apiData`.
2. Delete the map key.
3. Return `{consumed:true}`. No new entry pushed.

### 7.3 ADD path (`:80-142`)

No matching placeholder. Push a fresh COMPLETE entry, then (if pair exists) create placeholders for the pair step:

```
extraSteps.push({
  status: 'COMPLETE',
  actionId: extraStep.key,
  actionType: extraStep.type,
  owner, input, payloads: apiData,
  index: -1,                    // extras have no strict-sequence index
  isExtraStep: true,
  pairActionId: extraStep.pair, ...
})

if (extraStep.pair):
  pairStep = extrasByKey.get(extraStep.pair)
  if !pairStep:                 // dangling/asymmetric — tolerated, no placeholder
    return consumed
  if pair already COMPLETE for same messageId:  // both directions already fired
    return consumed
  pairStatus = extraFlowStatuses.get(pairStep.key) ?? ctx.flowStatus
  placeholders = buildPendingStep({step: pairStep, ..., flowStatus: pairStatus})
  for ph in placeholders:
    ph.isExtraStep = true
    ph.awaitingMessageId = apiData.messageId
    pendingPlaceholders[`${pairStep.key}::${apiData.messageId}`].push(idx)
    extraSteps.push(ph)
```

### 7.4 Placeholder match by api-service-managed apiList

When the pair callback arrives, the api-service has already written the new entry into `transactionData.apiList`. So on the next mapper run, the extras-resolver's RESOLVE path fires (`:66-78`) and the placeholder transitions to COMPLETE with payloads. By the time `findMatchingStep` in `incoming-request-controller.ts:122-149` runs, the placeholder is indistinguishable from any other COMPLETE entry and matches via the standard payloads key. There is no separate awaitingMessageId match path in the controller.

`MappedStep.awaitingMessageId` is retained as diagnostic metadata only.

### 7.5 Edge cases

| Case | Behaviour | Reference |
|---|---|---|
| Symmetric pair, both events arrive | First triggers ADD + placeholder; second triggers RESOLVE | E4, E5 tests in `flow-mapper.test.ts` |
| Same key fires twice with different messageIds | Two independent sub-flows (Map-keyed by messageId) | E6 test |
| Pair points at non-existent key | Tolerated: COMPLETE pushed, no placeholder | `:100-103`, E9 test |
| Asymmetric pair (only A.pair=B set) | Tolerated: when B fires alone, no placeholder for A | implied by tolerance above |
| Pair already COMPLETE for same messageId | Skip placeholder (short-circuit `:106-116`) | — |
| `unsolicited && !input && subscriber !== owner` for pair step | `buildPendingStep` returns 2 placeholders (INPUT-REQ + RESPONDING); both tracked | E17 test |
| Action matches both strict cursor AND extras | sequence-resolver wins (it's first in chain) | E10 test |
| Out-of-order strict action that also matches extras | extras-resolver wins (sequence-resolver only matches cursor; extras runs before missed) | E7 test |

---

## 8. MappedStep status truth table

`buildPendingStep` (`mapper/pending-step.ts:13-86`). Inputs: `(step.type, subscriberType vs step.owner, step.input, step.unsolicited, flowStatus, isImmediateNext)`. Output: `MappedStep[]` (usually 1, can be 2).

### 8.1 Non-immediate (any step beyond cursor or pair placeholder index)

| `isImmediateNext` | All other inputs | Result |
|---|---|---|
| `false` | (anything) | `[{ status: 'WAITING' }]` — single entry |

### 8.2 Immediate-next: HTML_FORM / DYNAMIC_FORM

| subscriber vs owner | `flowStatus` | Result |
|---|---|---|
| `subscriberType === step.owner` | `AVAILABLE` | `[{ status: 'INPUT-REQUIRED' }]` |
| `subscriberType === step.owner` | `WORKING` or `SUSPENDED` | `[{ status: 'PROCESSING' }]` |
| `subscriberType !== step.owner` | `AVAILABLE` | `[{ status: 'WAITING-SUBMISSION' }]` |
| `subscriberType !== step.owner` | `WORKING` or `SUSPENDED` | `[{ status: 'RESPONDING' }]` |

(`pending-step.ts:36-56`)

### 8.3 Immediate-next: non-form, subscriber == owner

`pending-step.ts:59-61`. Mock is **listening** for the SUT to call.

| `flowStatus` | Result |
|---|---|
| any | `[{ status: 'LISTENING' }]` |

### 8.4 Immediate-next: non-form, subscriber != owner, has `input`

`pending-step.ts:63-72`. Mock is going to **respond**, may need user inputs.

| `flowStatus` | Result |
|---|---|
| `AVAILABLE` | `[{ status: 'INPUT-REQUIRED' }]` |
| `WORKING` or `SUSPENDED` | `[{ status: 'RESPONDING' }]` |

### 8.5 Immediate-next: non-form, subscriber != owner, no `input`, **unsolicited**

`pending-step.ts:75-85`. The **dual-push** quirk: pushes both an INPUT-required-style entry AND a RESPONDING entry.

| `flowStatus` | Result |
|---|---|
| `AVAILABLE` | `[{ status: 'INPUT-REQUIRED', input: [] }, { status: 'RESPONDING' }]` |
| `WORKING` or `SUSPENDED` | `[{ status: 'RESPONDING', input: [] }, { status: 'RESPONDING' }]` |

Both placeholders independently tracked in `pendingPlaceholders` when used as extras pair (E17 test).

### 8.6 Immediate-next: non-form, subscriber != owner, no input, **not unsolicited**

`pending-step.ts:84-86`.

| `flowStatus` | Result |
|---|---|
| any | `[{ status: 'RESPONDING' }]` |

### 8.7 `LISTENING` semantics

`LISTENING` means: mock waits for SUT to call this action. Active step from the dispatcher's POV: `actOnFlowService` creates an Expectation via `SubscriberCacheService.createExpectation` (`process-flow.ts:178-189` + `workbench-cache.ts:400-477`) **only if** `step.expect === true` AND a sessionId exists.

### 8.8 Actionable subset

`process-flow.ts` `DISPATCH_STATUSES = {RESPONDING, INPUT-REQUIRED, WAITING-SUBMISSION}` (`:26-30`). LISTENING is "actionable" only in the sense of creating an expectation; not enqueued as a job.

`getNextActions` (`flow-mapper.ts:36-55`) filters `sequence.find(s => ACTIONABLE_STATUSES.has(s.status))` and `extraSteps.filter(...)` where `ACTIONABLE_STATUSES = DISPATCH_STATUSES + {LISTENING}` (`flow-mapper.ts:11-16`). LISTENING percolates into `sequenceNext` for the expectation path.

---

## 9. State machines

### 9.1 `MockFlowStatusCache` (per-transaction)

Schema: `{ status: 'AVAILABLE' | 'WORKING' | 'SUSPENDED' }` (`mock-service-types.ts:16-22`). Redis key `FLOW_STATUS_${txId}::${subscriberUrl}` (`workbench-cache.ts:240-245`), TTL 5h (`:294`).

| Transition | Writer | File:line | Trigger |
|---|---|---|---|
| → `WORKING` | mock | `process-flow.ts:253-262` | `dispatchTarget` for sequence target (else-branch) |
| `WORKING` → `AVAILABLE` | api-service | (out of repo) | api-service finishes processing the request mock sent |
| `WORKING` → `AVAILABLE` | mock fallback | `generate-response.ts:168-174` | exception in payload generation job |
| → `SUSPENDED` | (manual / operational) | (no in-repo writer) | observed read-only |

**Reads** (gates):

| Read site | File:line | Gates |
|---|---|---|
| `actOnFlowService` `SUSPENDED` early-exit | `process-flow.ts:48-53` | abort entire call |
| `actOnFlowService` sequence target | `:97-103` | requires `AVAILABLE` to dispatch sequence |
| `actOnFlowService` 0-jobs fallback | `:191-195` | reports `'Flow is already being processed'` when WORKING |
| `getFlowStatusController` | `flow-controller.ts:256-263` | passed to mapper to compute pending-step statuses |
| `getNextActions` via mapper | `flow-map-builder.ts:97-103` | each pending step's status computed against this |
| `validateAndSaveIncomingRequest` | `incoming-request-controller.ts:50-56` | passed to mapper |

Default-on-miss: AVAILABLE (`workbench-cache.ts:271`). Errors fall back to AVAILABLE too (`:278`).

### 9.2 Extras flow status (per-extra-step)

Same enum, same TTL. Redis key `EXTRA_FLOW_STATUS_${txId}::${subscriberUrl}::${extraStepKey}` (`workbench-cache.ts:247-253`).

| Transition | Writer | File:line | Trigger |
|---|---|---|---|
| → `WORKING` | mock | `process-flow.ts:244-253` | `dispatchTarget` for extras target |
| `WORKING` → `AVAILABLE` | api-service | (out of repo) | api-service finishes processing extras request — **api-service modification required for the extras feature** |

**Reads** (gates):

| Read site | File:line | Gates |
|---|---|---|
| `loadExtraFlowStatuses` | `process-flow.ts:213-233` | builds Map passed to mapper; per-step gating |
| Per-extras-target gate | `:118-119` | requires per-step `AVAILABLE` to dispatch |
| extras-resolver placeholder status | `mapper/resolvers/extras-resolver.ts:118-126` | uses per-step status as `flowStatus` arg to `buildPendingStep` |

Default-on-miss: AVAILABLE (`workbench-cache.ts:332`).

### 9.3 `MappedStep.status` enum

Already covered in §8. Compact reference:

```
COMPLETE          : event/payload already observed
LISTENING         : mock awaits incoming call (will create expectation if step.expect)
RESPONDING        : mock will dispatch (job)
WAITING           : non-immediate pending step
INPUT-REQUIRED    : RESPONDING but needs user inputs before payload generation
PROCESSING        : form step whose owner is subscriber, while WORKING
WAITING-SUBMISSION: form step waiting for user submission (subscriber != owner)
```

### 9.4 Expectations (`SubscriberCacheService`)

Independent of flow status — controls whether an inbound webhook is expected. Key: `subscriberUrl`. TTL: 5 min per expectation (`workbench-cache.ts:398`).

| Op | File:line | Notes |
|---|---|---|
| `createExpectation` | `:400-477` | rejects if duplicate sessionId, rejects if duplicate expectedAction, prunes expired |
| `deleteExpectation` | `:479-510` | filters by sessionId |
| `getSubscriberData` | (in same file) | fetches all expectations for subscriber |

---

## 10. Form variants

### 10.1 Side-by-side

| Property | HTML_FORM | HTML_FORM_MULTI | DYNAMIC_FORM |
|---|---|---|---|
| Source | external party (URL embedded in upstream API response) | external party | mock-generated |
| Creation trigger | strict sequence step | strict sequence step | strict sequence step |
| Session storage key | `sessionData[step.actionId]` = form URL (then resolved HTML) | same | `sessionData[step.actionId]` = submission ID |
| Validation | `validateFormHtml` (`utils/form-utils.ts:67+`) | same | n/a (HTML decoded from base64 config) |
| URL resolution | `resolveFormActions` (`utils/form-utils.ts:10-46`) | same | n/a |
| Processed by | `processHtmlFormStep` in `incoming-request-controller.ts:348-417` | same path (treated identically) | `actOnFlowService` → `API_SERVICE_FORM_REQUEST_JOB` |
| Submit path | (external) | (external) | `POST /forms/:domain/:formId/submit` |
| Surfaces in `reference_data` | yes (resolved HTML) | yes | yes (submission ID) |
| Failure mode | enqueue `API_SERVICE_FORM_REQUEST_JOB` with `{code:'FORM_VALIDATION_ERROR'}` then ACK | same | throws on missing config; HTTP 500 from controller |

### 10.2 `validateFormHtml` (`utils/form-utils.ts`)

Rejects (in order):
1. Forbidden tags: `<iframe>`, `<object>`, `<embed>` (`:75-80`)
2. Inline event handlers (any attribute starting `on*`) (`:83-95`)
3. `javascript:` URLs in `href`/`src`/`action` (`:97-114`)
4. Multiple `<form>` elements (single form required)
5. Missing/invalid form `action` attribute

Returns `{ ok: boolean; errors: string[]; warnings: string[]; details? }`.

### 10.3 `processHtmlFormStep` (`incoming-request-controller.ts:348-417`)

Triggered only after a strict-sequence API step's data is saved AND the next step in `sequence` is HTML_FORM / HTML_FORM_MULTI AND the matching step is NOT an extras step (`incoming-request-controller.ts:264-302` guard at `:276`).

| Branch | File:line | Effect |
|---|---|---|
| `sessionData[nextStep.actionId]` (form URL) missing | `:353-365` | warn, `{shouldRespond:false}` (continue without form) |
| `axios.get(formLink)` fails | catch at `:404-415` | log, `{shouldRespond:false}` |
| `validateFormHtml(html).ok === false` | `:373-391` | enqueue error form-job; `{shouldRespond:true}` → outer ACKs |
| Validation passes | `:393-402` | `resolveFormActions` rewrites relative actions; `overwriteMockSessionData` saves resolved HTML; `{shouldRespond:false}` |

### 10.4 DYNAMIC_FORM submission lifecycle

1. Mock dispatches `API_SERVICE_FORM_REQUEST_JOB` (`process-flow.ts:243-274`).
2. Api-service responds; user opens `/forms/:domain/:formId?direct=true` (HTML rendered by `handleGetFormService`).
3. User submits → `POST /forms/:domain/:formId/submit` → `handleFormSubmitService` (`form-handlers.ts:62-139`):
   - `randomUUID()` → `submissionID`
   - `updateSessionWithFormSubmission(...)` writes `sessionData.formSubmissions[txId_formId]`
   - `addFormData(...)` writes `sessionData.formData[formId]`
   - `actOnFlowService({...inputs:{submission_id}})` continues flow
   - Returns animated success HTML (auto-close in 5s, `form-handlers.ts:141-395`)

---

## 11. Job pipelines

Three job types. All implement `IQueueService` job handlers (`queue/IQueueService.ts`). Registration in `container/implementations/main.ts` via `queue.process(...)` and `queue.on(...)`.

### 11.1 `GENERATE_PAYLOAD_JOB` (`service/jobs/generate-response.ts`)

Triggered by `process-flow.ts:dispatchTarget` for non-form targets (`:289-291`).

Handler (`createGeneratePayloadJobHandler`, `:34-178`):

| Phase | File:line | Branches |
|---|---|---|
| 1. Load runner + session | `:49-77` | Sets `bapUri`/`bppUri`, optional `finvuUrl` |
| 2. `runMeetRequirementsWithSession` | `:79-103` | `success:false` → return success with `buildErrorPayload('REQUIREMENTS_CHECK_ERROR')` |
| 3. Check `result.valid` | `:105-127` | `valid:false` → return success with `buildErrorPayload('REQUIREMENTS_NOT_MET')` |
| 4. `runGeneratePayloadWithSession` | `:129-153` | `success:false` → `buildErrorPayload('GENERATION_ERROR')` |
| 5. Payload undefined | `:155-158` | throw |
| 6. Success | `:160-165` | `{success:true, payload}` |
| Exception | `:166-176` | log, `setFlowStatus(...,'AVAILABLE')` fallback, rethrow |

**`*JobComplete`** (`createGenerationRequestCompleteHandler`, `:197-259`):
1. Build `ApiServiceRequestJobParams` from `flowContext`.
2. `getSaveDataConfig(...)` from runner config.
3. `saveMockSessionData(...)` to merge payload into session via JSONPath/EVAL.
4. `queue.enqueue(SEND_TO_API_SERVICE_JOB, params)`.
5. Errors logged but swallowed (`:255-257`).

**`*JobFailed`** (`generateRequestPayloadJobFailed`, `:180-196`): logs only.

### 11.2 `SEND_TO_API_SERVICE_JOB` (`service/jobs/api-service-request.ts`)

Triggered by `*JobComplete` of GENERATE_PAYLOAD_JOB.

Handler (`:22-59`):
| Phase | File:line | Branches |
|---|---|---|
| Build URL | `:25-29` | `${API_SERVICE_URL}/${domain}/${version}/mock/${action}` |
| POST | `:34-38` | axios with `queryParams` |
| Success | `:39-43` | `{success:true, statusCode, responseBody}` |
| AxiosError | `:44-57` | `{success:false, statusCode, responseBody}` |
| Other | `:46-51` | `{success:false, message:'Unknown error occurred'}` |

`*JobComplete` (`:61-69`): log only. `*JobFailed` (`:71-80`): log only.

Note: this job does NOT reset `flowStatus` to AVAILABLE on completion. That happens via api-service writing back to Redis after it finishes processing (existing protocol).

### 11.3 `API_SERVICE_FORM_REQUEST_JOB` (`service/jobs/api-service-form-request.ts`)

Triggered by `process-flow.ts:dispatchTarget` for form targets (`:268-274`) AND by `processHtmlFormStep` on validation failure (`incoming-request-controller.ts:385`).

Handler (`:24-69`):
| Phase | File:line | Branches |
|---|---|---|
| Build URL | `:27-31` | `${API_SERVICE_URL}/${domain}/${version}/form/html-form` |
| POST body | `:36-47` | `{context, subscriber_url, transaction_id, form_action_id, form_type, submissionId, error?}` |
| Success/failure | `:49-67` | same shape as SEND_TO_API_SERVICE_JOB |

Job constant name vs string: `API_SERVICE_FORM_REQUEST_JOB` constant value is `'API_SERVICE_FORMS_JOB'` (`:5`). Keep this in mind when reading queue logs.

---

## 12. Cache layer reference

Two Redis DBs (`env.ts:1-18`, container DI):

| DB | Service | Purpose |
|---|---|---|
| DB 0 | `WorkbenchCacheService` | transactional data, sessions, mock session business state, flow status, expectations |
| DB 1 | `MockRunnerConfigCache` | mock runner configurations |

### 12.1 WorkbenchCacheService (`service/cache/workbench-cache.ts`)

Composite of 4 sub-services exposed via getters (`:519-565`).

| Sub-service | Key shape | TTL | Default-on-miss | Notes |
|---|---|---|---|---|
| `TransactionalCacheService` | `${txId}::${subscriberUrl}` | none / external | throws if missing (`:34-38`) | `getTransactionData(txId, subscriberUrl)` |
| `NpSessionalCacheService` | `${sessionId}` | external | throws | `getSessionData`, `updateSessionWithFormSubmission` (`:47-86`) |
| `TxnBusinessCacheService` | `MOCK_DATA::${txId}::${subscriberUrl}` | external | returns minimal stub if missing (`:103-115`) | `getMockSessionData`, `saveMockSessionData` (JSONPath/EVAL merge), `overwriteMockSessionData`, `addFormData`, `addFormSubmissionId` (`:88-237`) |
| `FlowStatusCacheService` | `FLOW_STATUS_${txId}::${subscriberUrl}` and `EXTRA_FLOW_STATUS_${txId}::${subscriberUrl}::${stepKey}` | 5h | `{status:'AVAILABLE'}` (`:271`, `:332`) | `getFlowStatus`, `setFlowStatus`, `deleteFlowStatus`, plus the three extras-status methods (`:316-385`) |
| `SubscriberCacheService` | `${subscriberUrl}` | 5min per expectation (`:398`) | empty `activeSessions:[]` | `createExpectation`, `deleteExpectation`, `getSubscriberData` (`:397-510`) |

`saveMockSessionData` JSONPath/EVAL semantics:
- Key with `APPEND#` prefix → append to existing array (`:138-150`)
- Value with `EVAL#` prefix → run user function via `MockRunner.runGetSave` (`:142-146`)
- Else → JSONPath extract (`:147`)
- Reserved auto-injected keys: `latestMessage_id`, `bapUri`, `bppUri`, `bppId`, `bapId` (`:133-137`)

### 12.2 MockRunnerConfigCache (`service/cache/config-cache.ts`)

Hybrid in-memory + Redis cache for `MockRunner` instances and configs. Runner instances have 5min TTL (`:34`), config cache has explicit fetch fallback.

| Method | File:line | Behaviour |
|---|---|---|
| `getMockRunnerConfig(domain, version, flowId, usecaseId, sessionId?)` | `:70+` | PLAYGROUND-FLOW case reads `cache0:PLAYGROUND_${sessionId}`; else reads `cache1:${domain}::${version}::${flowId}::${usecaseId}` with fetch-on-miss via `fetchMockRunnerConfigFromService` |
| `getRunnerInstance(...)` | (later in file) | in-memory cache by composite key; in-flight dedup via `mockRunnerInFlight` map; TTL eviction |

---

## 13. Error codes & exceptions

### 13.1 Internal `ERROR_CODES` (`constants/error-codes.ts:1-22`)

| Key | Code | HTTP | Message |
|---|---|---|---|
| `INTERNAL_ERROR` | `GEN_000` | 500 | Internal server error. |
| `TOO_MANY_REQUESTS` | `GEN_001` | 429 | Too many requests. Please try again later. |
| `HEALTH_CHECK_FAILED` | `GEN_004` | 503 | Health check failed. |
| `BAD_REQUEST` | `GEN_002` | 400 | Bad request. |

### 13.2 `ONDC_ERROR_CODES` (`constants/error-codes.ts:24-675`)

Large set, used with `sendNack`. No HTTP status — protocol error envelope returns HTTP 200 with `{message:{ack:{status:'NACK'}}, error:{type, code, message}}`. Selected:

| Code | Type | Message |
|---|---|---|
| `10000` | Gateway | Bad or Invalid request error |
| `10001` | Gateway | Invalid Signature |
| `20000–22509` | BNP | catalog/order/quote/cancellation errors |
| `23001`/`23002` | BNP | Internal Error / Order validation failure |
| `25001`/`27501`/`27502` | BNP | Confirm/terms failures |
| `30000–30023` | SNP | request/order/serviceability errors |
| `31001` | SNP | Internal Error (most thrown path in this repo) |
| `31002`/`31003` | SNP | Order validation failure / processing in progress |
| `40000+` / `50000+` | SNP | business/policy errors |
| `60000+` / `61000+` / `65000+` / `66000+` | LSP | location/order/internal |
| `62500+` / `63000+` / `64000+` | LBNP | terms/RTO/internal |

Full table in source.

### 13.3 Custom exception classes (`errors/custom-errors.ts`)

| Class | File:line | When thrown | Handler maps to |
|---|---|---|---|
| `OndcProtocolError(code, message, customMessage?)` | `:3-17` | every controller's catch wraps unknowns into this with `'31001'`; also throws from specific OndcContractError sites | `sendNack` (HTTP 200, NACK envelope) |
| `httpValidationError(message, details[])` | `:19-26` | `validateRequiredParams`, `backdoor-controller` | `sendError('BAD_REQUEST', message, {details})` — 400 |
| `InternalServerError(message)` | `:28-33` | missing session/flowContext, infrastructure failures | `sendError('INTERNAL_ERROR', message)` — 500 |
| `isBodyParserJsonError(err)` (predicate) | `:35-49` | identifies malformed JSON from `express.json` | special-cased to 400 with hint |
| `normalizeError(error, fallback)` (helper) | `:51-57` | unifies unknown thrown values into Error | passes through Errors; uses fallback otherwise |

### 13.4 Response helpers (`utils/res-utils.ts`)

Controllers must never call `res.json` / `res.send` directly — enforced by custom ESLint rule `no-direct-response` (per `CLAUDE.md`). Always use:

| Helper | Use |
|---|---|
| `sendSuccess(res, data, simpleBody?, message?, statusCode?)` | success responses, default 200 |
| `sendError(res, errorCode, message?, details?)` | error responses, HTTP from `ERROR_CODES[errorCode].httpStatus` |
| `sendAck(res, context)` | ONDC ACK envelope (HTTP 200) |
| `sendNack(res, context, code, message)` | ONDC NACK envelope (HTTP 200) |

---

## 14. Cross-cutting

### 14.1 Queue (`queue/IQueueService.ts`)

Two implementations:
- `InMemoryQueue` — dev / single-instance
- `RabbitMQ` — production (used when `RABBITMQ_URL` set)

Both expose: `process<T>(jobName, handler, onComplete, onFail)`, `enqueue<T>(jobName, data) → jobId`.

### 14.2 Service container (`container/implementations/main.ts`)

`ServiceContainer` singleton, lazy-init pattern with setter overrides for tests. Services:

| Field | Getter | Backed by |
|---|---|---|
| `cacheService0` / `cacheService1` | `getCacheServiceN()` | Redis DB 0 / DB 1 |
| `queueService` | `getQueueService()` | InMemoryQueue or RabbitMQ |
| `workbenchCacheService` | `getWorkbenchCacheService()` | composes the 4 sub-services |
| `mockRunnerConfigCache` | `getMockRunnerConfigCache()` | DB 1 + runner-instance memo |

Adding a new service: private field + lazy getter + setter (test override) + reset case + DI in `InitMainContainer()`.

### 14.3 Custom ESLint rule

`no-direct-response` (`eslint-rules/index.mjs`, enforced in `eslint.config.mjs:69-88`): controllers must use `res-utils` helpers, not `res.json()` / `res.send()`. Allowed files: `*-res-utils.ts`, `*.test.ts`, `server.ts`.

### 14.4 Environment variables

`env.ts:2-10` requires at runtime:

| Var | Notes |
|---|---|
| `NODE_ENV` | required |
| `BASE_URL` | required, used in form rendering |
| `API_SERVICE_URL` | required, used by job handlers |
| `CONFIG_SERVICE_URL` | required, used by `fetchMockRunnerConfigFromService` |
| `REDIS_HOST`, `REDIS_PORT` | required |
| `REDIS_USERNAME`, `REDIS_PASSWORD` | optional |
| `REDIS_DB_0`, `REDIS_DB_1` | DB indexes |
| `RABBITMQ_URL` | optional; if absent → InMemoryQueue |
| `FINVU_AA_SERVICE_URL` | optional; injected into `txnMockData.finvuUrl` in payload generation |
| `LOG_LEVEL`, `LOG_FULL_RESPONSE` | logging knobs |
| `MEMORY_PROFILER_INTERVAL_MS` | memory profiler tick |
| `PORT` | server port |

### 14.5 Server boot (`server.ts`)

Middleware stack order (`server.ts:18-66`):
1. `logger.getCorrelationIdMiddleware()`
2. `requestLogger`
3. `responseLogger`
4. `cors()`
5. Ops endpoints (`/metrics`, `/memory`, `/heapdump`, `/health`)
6. `express.json({ limit: '3mb' })`
7. `express.urlencoded({ extended: true })`
8. Business router at `/mock/playground`
9. `globalErrorHandler`

Note: `/health`, `/metrics`, `/memory`, `/heapdump` are mounted BEFORE JSON body parser — they don't consume bodies.

---

## Appendix: out-of-repo dependencies

- `@ondc/automation-mock-runner` — exposes `runMeetRequirementsWithSession`, `runGeneratePayloadWithSession`, `runValidatePayloadWithSession`, `runGetSave`, `decodeBase64`. Wraps user-authored JS for per-action validate + meetRequirements + generate + saveData.
- External api-service — receives mock dispatches, writes results back to Redis (`flowStatus` reset, apiList updates). The extras-status reset is **also** owned by api-service (extras feature requires api-service modification to write `EXTRA_FLOW_STATUS_*` AVAILABLE on completion).

## Maintenance

- This doc is a snapshot. When you change a branch, update the corresponding row here too.
- The "Last reviewed" date at the top should be bumped whenever sections are touched.
