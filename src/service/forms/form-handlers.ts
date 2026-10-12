import MockRunner from '@ondc/automation-mock-runner';
import { SessionCache, TransactionCache } from '../../types/cache-types';
import { MockRunnerConfig } from '../../types/mock-runner-types';
import { GetFormQuery, SubmitFormQuery } from '../../types/request-types';
import ejs from 'ejs';
import { randomUUID } from 'crypto';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';
import { actOnFlowService } from '../flows/process-flow';
import { IQueueService } from '../../queue/IQueueService';
import {
    getBeautifulForm,
    extractFieldConstraints,
    FieldConstraint,
} from '../../utils/form-utils';
import { httpValidationError } from '../../errors/custom-errors';

function describeFormatViolation(
    field: FieldConstraint,
    value: unknown
): string | undefined {
    if (typeof value !== 'string') {
        return 'must be a string value';
    }
    if (field.pattern) {
        try {
            // HTML pattern semantics: the whole value must match.
            if (!new RegExp(`^(?:${field.pattern})$`).test(value)) {
                return `does not match the seller's declared pattern "${field.pattern}"`;
            }
        } catch {
            // An invalid pattern in the seller's own HTML is a form-authoring problem,
            // not something the buyer's submission can be faulted for.
        }
    }
    if (field.minLength !== undefined && value.length < field.minLength) {
        return `must be at least ${field.minLength} characters`;
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `must be at most ${field.maxLength} characters`;
    }
    return undefined;
}

/**
 * Validates an html_form_multi submission's array shape against the seller's own form HTML —
 * no business field name (e.g. "dob", "panValue") is hardcoded; every non-hidden field the form
 * declares is treated the same way, generically:
 *  - the submitted body itself must be a plain JSON/form object (key → value or key → array of
 *    values) — not null, not an array, not a bare string/number. The buyer app's construct is
 *    { "dob": ["17/11/2021", "19/12/2003"], "panValue": ["RKPUS3413T", "SKPUS3413L"] }: a flat
 *    object whose values are arrays (or, for a single member, bare scalars — see below). Anything
 *    that isn't shaped like that at all is rejected here, before any per-field check runs, so a
 *    malformed body fails loudly instead of either crashing deeper in or silently skipping
 *    validation because indexing into it just returns undefined for every field.
 *  - every such field must actually be submitted in key:array-of-values form. multipart/form-data
 *    can't tell "one array element" apart from "a plain scalar" when a field is only submitted
 *    once (a single-member family, say), so a bare scalar is normalized into a single-element
 *    array here rather than rejected outright — the construct is still array-of-values, just
 *    length 1.
 *  - all of those arrays must agree on length — positional correlation: field_a[i] and
 *    field_b[i] must belong to the same member, so a buyer that only repeated one of several
 *    fields is a contract violation, not a quirk to tolerate.
 *  - each value must match whatever `pattern`/`minlength`/`maxlength` the seller's HTML declared
 *    for that field, at every index.
 * Throws httpValidationError (→ 400) on the first category of violation found.
 */
export function validateMultiFormSubmission(
    formData: unknown,
    formHtml: string
): void {
    if (
        typeof formData !== 'object' ||
        formData === null ||
        Array.isArray(formData)
    ) {
        throw new httpValidationError(
            'Malformed multi-submission: expected a JSON object mapping each field name to its value(s) (e.g. { "dob": ["17/11/2021", "19/12/2003"], "panValue": ["RKPUS3413T", "SKPUS3413L"] })',
            [
                `received ${
                    formData === null
                        ? 'null'
                        : Array.isArray(formData)
                          ? 'an array'
                          : typeof formData
                } instead of an object`,
            ]
        );
    }

    const data = formData as Record<string, unknown>;

    const fields = extractFieldConstraints(formHtml).filter(f => !f.hidden);
    if (fields.length === 0) return;

    // Normalize every declared field to an array, so a single-member submission (which
    // multipart collapses to a bare scalar) still participates in the length check below
    // instead of silently skipping it. Fields the buyer didn't submit at all are left out —
    // required-ness is the buyer UI's concern, not this shape check's.
    const arrayFields: [string, unknown[]][] = fields
        .map((field): [string, unknown[]] | undefined => {
            const value = data[field.name];
            if (value === undefined) return undefined;
            return [field.name, Array.isArray(value) ? value : [value]];
        })
        .filter((entry): entry is [string, unknown[]] => entry !== undefined);
    if (arrayFields.length === 0) return;

    const lengths = new Set(arrayFields.map(([, values]) => values.length));
    if (lengths.size > 1) {
        throw new httpValidationError(
            'Malformed multi-submission: every field must submit the same number of entries (as an array of values, one per member)',
            arrayFields.map(
                ([name, values]) => `${name} has ${values.length} entries`
            )
        );
    }

    const byName = new Map(fields.map(f => [f.name, f]));
    const details: string[] = [];
    for (const [name, values] of arrayFields) {
        const field = byName.get(name);
        if (!field) continue;
        values.forEach((value, index) => {
            const problem = describeFormatViolation(field, value);
            if (problem) {
                details.push(
                    `${name}[${index}] = "${String(value)}" ${problem}`
                );
            }
        });
    }
    if (details.length > 0) {
        throw new httpValidationError(
            'Malformed multi-submission field value(s)',
            details
        );
    }
}

export const handleGetFormService = async (
    stepConfig: MockRunnerConfig['steps'][0],
    transactionData: TransactionCache,
    getFormQueryData: GetFormQuery,
    formId: string,
    domain: string,
    preferHtml: boolean
) => {
    if (
        stepConfig.api !== 'dynamic_form' &&
        stepConfig.api != 'html_form' &&
        stepConfig.api != 'html_form_multi'
    ) {
        throw new Error('Invalid API type for form rendering');
    }
    if (stepConfig.api === 'dynamic_form') {
        const formRenderUrl = `${process.env.BASE_URL}/forms/${domain}/${formId}?transaction_id=${getFormQueryData.transaction_id}&session_id=${getFormQueryData.session_id}&direct=true`;
        if (!getFormQueryData.direct && !preferHtml) {
            return {
                dataType: 'json',
                data: {
                    success: true,
                    type: 'dynamic',
                    formUrl: formRenderUrl,
                    message:
                        'Please open the formUrl and submit the form to proceed with the flow',
                },
            };
        }
    }

    const submitUrl = `${process.env.BASE_URL}/forms/${domain}/${formId}/submit?transaction_id=${getFormQueryData.transaction_id}&session_id=${getFormQueryData.session_id}`;
    const htmlContent = MockRunner.decodeBase64(stepConfig.mock.formHtml ?? '');
    if (!htmlContent) {
        throw new Error(
            'Form HTML content not found in config for form: ' +
                stepConfig.action_id
        );
    }
    const submissionData = {
        session_id: getFormQueryData.session_id,
        transaction_id: getFormQueryData.transaction_id,
        flow_id: transactionData.flowId,
    };
    const newContent = ejs.render(getBeautifulForm(htmlContent), {
        actionUrl: submitUrl,
        submissionData: JSON.stringify(submissionData),
        formId: formId,
    });
    return {
        dataType: 'html',
        data: newContent,
    };
};

export const handleFormSubmitService = async (
    stepConfig: MockRunnerConfig['steps'][0],
    formData: Record<string, unknown>,
    workbenchCache: WorkbenchCacheServiceType,
    queryData: SubmitFormQuery,
    formId: string,
    sessionData: SessionCache,
    transactionData: TransactionCache,
    queueService: IQueueService
) => {
    if (
        stepConfig.api !== 'dynamic_form' &&
        stepConfig.api != 'html_form' &&
        stepConfig.api != 'html_form_multi'
    ) {
        throw new Error('Invalid API type for form rendering');
    }
    if (stepConfig.api === 'html_form_multi') {
        const formHtml = MockRunner.decodeBase64(
            stepConfig.mock.formHtml ?? ''
        );
        validateMultiFormSubmission(formData, formHtml);
    }
    const submissionID = randomUUID();
    formData.form_submission_id = submissionID;
    if (
        stepConfig.api === 'dynamic_form' ||
        stepConfig.api === 'html_form' ||
        stepConfig.api === 'html_form_multi'
    ) {
        // proceed function
        await workbenchCache
            .NpSessionalCacheService()
            .updateSessionWithFormSubmission(
                queryData.session_id,
                queryData.transaction_id,
                submissionID,
                formId
            );
        await workbenchCache
            .TxnBusinessCacheService()
            .addFormData(
                queryData.transaction_id,
                sessionData.subscriberUrl,
                queryData.session_id,
                formId,
                formData
            );
        await actOnFlowService(
            {
                flow: sessionData.flowConfigs[transactionData.flowId],
                flowId: transactionData.flowId,
                transactionId: queryData.transaction_id,
                sessionId: queryData.session_id,
                subscriberUrl: sessionData.subscriberUrl,
                apiSessionCache: sessionData,
                transactionData: transactionData,
                domain: sessionData.domain,
                version: sessionData.version,
                inputs: {
                    submission_id: submissionID,
                },
            },
            workbenchCache,
            queueService
        );
        if (
            stepConfig.api === 'html_form' ||
            stepConfig.api === 'html_form_multi'
        ) {
            return {
                dataType: 'json',
                data: {
                    success: true,
                    submission_id: submissionID,
                },
            };
        }
        const successHtml = getSuccessHtml(submissionID);
        // proceed function
        return {
            dataType: 'html',
            data: successHtml,
        };
    } else {
        // proceed function
        return {
            dataType: 'json',
            data: {
                success: true,
                submission_id: submissionID,
            },
        };
    }
};

const getSuccessHtml = (submissionID: string) => `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Form Submitted Successfully</title>
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }
            
            body {
            font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #ebebeb 0%, #c1dce6 50%, #b3e7ff 100%);
            padding: 1rem;
            }
            
            .success-container {
              text-align: center;
              background: white;
              padding: 3.5rem 3rem;
              border-radius: 1.25rem;
              box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
              max-width: 550px;
              width: 100%;
              position: relative;
              overflow: hidden;
            }
            
            .success-container::before {
              content: '';
              position: absolute;
              top: 0;
              left: 0;
              right: 0;
              height: 4px;
              background: linear-gradient(90deg, #0ea5e9, #38bdf8, #7dd3fc);
            }
            
            .success-icon {
              width: 80px;
              height: 80px;
              background: linear-gradient(135deg, #0ea5e9, #38bdf8);
              border-radius: 50%;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              margin-bottom: 1.5rem;
              animation: scaleIn 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55);
              box-shadow: 0 10px 25px rgba(14, 165, 233, 0.3);
            }
            
            .success-icon::after {
              content: '✓';
              color: white;
              font-size: 3rem;
              font-weight: bold;
            }
            
            h1 {
              color: #0f172a;
              font-size: 1.875rem;
              font-weight: 700;
              margin-bottom: 0.5rem;
              letter-spacing: -0.025em;
            }
            
            .subtitle {
              color: #0ea5e9;
              font-size: 0.875rem;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.05em;
              margin-bottom: 1rem;
            }
            
            .description {
              color: #64748b;
              font-size: 1rem;
              margin-bottom: 2rem;
              line-height: 1.6;
            }
            
            .submission-id {
              background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
              border: 1px solid #bae6fd;
              padding: 1rem;
              border-radius: 0.75rem;
              font-family: 'Courier New', Courier, monospace;
              font-size: 0.875rem;
              color: #0c4a6e;
              margin-bottom: 1.5rem;
              position: relative;
              overflow: hidden;
            }
            
            .submission-id::before {
              content: '';
              position: absolute;
              top: 0;
              left: -100%;
              width: 100%;
              height: 100%;
              background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
              animation: shimmer 2s infinite;
            }
            
            .submission-label {
              display: block;
              font-size: 0.75rem;
              color: #0369a1;
              margin-bottom: 0.25rem;
              font-weight: 600;
            }
            
            button {
              background: linear-gradient(135deg, #0ea5e9, #38bdf8);
              color: white;
              border: none;
              padding: 0.875rem 2.5rem;
              border-radius: 0.75rem;
              font-size: 1rem;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.3s ease;
              box-shadow: 0 4px 15px rgba(14, 165, 233, 0.3);
              position: relative;
              overflow: hidden;
            }
            
            button::before {
              content: '';
              position: absolute;
              top: 0;
              left: -100%;
              width: 100%;
              height: 100%;
              background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
              transition: left 0.5s;
            }
            
            button:hover::before {
              left: 100%;
            }
            
            button:hover {
              transform: translateY(-2px);
              box-shadow: 0 6px 20px rgba(14, 165, 233, 0.4);
            }
            
            button:active {
              transform: translateY(0);
            }
            
            .auto-close-text {
              font-size: 0.875rem;
              color: #94a3b8;
              margin-top: 1.5rem;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 0.5rem;
            }
            
            .countdown {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              width: 24px;
              height: 24px;
              background: #f1f5f9;
              border-radius: 50%;
              font-weight: 600;
              color: #0ea5e9;
              font-size: 0.75rem;
            }
            
            @keyframes scaleIn {
              0% {
                transform: scale(0) rotate(-180deg);
                opacity: 0;
              }
              100% {
                transform: scale(1) rotate(0deg);
                opacity: 1;
              }
            }
            
            @keyframes shimmer {
              to {
                left: 100%;
              }
            }
            
            @media (max-width: 640px) {
              .success-container {
                padding: 2.5rem 1.5rem;
              }
              
              h1 {
                font-size: 1.5rem;
              }
              
              .success-icon {
                width: 70px;
                height: 70px;
              }
              
              .success-icon::after {
                font-size: 2.5rem;
              }
            }
          </style>
          <script>
            let countdown = 5;
            const countdownElement = document.getElementById('countdown');
            
            const timer = setInterval(function() {
              countdown--;
              if (countdownElement) {
                countdownElement.textContent = countdown;
              }
              if (countdown <= 0) {
                clearInterval(timer);
                window.close();
              }
            }, 1000);
          </script>
        </head>
        <body>
          <div class="success-container">
            <div class="success-icon"></div>
            <h1>Form Submitted Successfully!</h1>
            <div class="subtitle">ONDC Protocol Workbench Dynamic Forms</div>
            <p class="description">Your form has been submitted and the flow will continue automatically.</p>
            <div class="submission-id">
              <span class="submission-label">Submission ID</span>
              ${submissionID}
            </div>
            <button onclick="window.close()">Close Window</button>
            <p class="auto-close-text">
              Auto-closing in <span class="countdown" id="countdown">5</span> seconds
            </p>
          </div>
        </body>
        </html>
      `;
