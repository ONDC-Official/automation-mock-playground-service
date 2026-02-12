import MockRunner from '@ondc/automation-mock-runner';
import { SessionCache, TransactionCache } from '../../types/cache-types';
import { MockRunnerConfig } from '../../types/mock-runner-types';
import { GetFormQuery, SubmitFormQuery } from '../../types/request-types';
import ejs from 'ejs';
import { randomUUID } from 'crypto';
import { WorkbenchCacheServiceType } from '../cache/workbench-cache';
import { actOnFlowService } from '../flows/process-flow';
import { IQueueService } from '../../queue/IQueueService';

export const handleGetFormService = async (
    stepConfig: MockRunnerConfig['steps'][0],
    transactionData: TransactionCache,
    getFormQueryData: GetFormQuery,
    formId: string,
    domain: string
) => {
    if (stepConfig.api !== 'dynamic_form' && stepConfig.api != 'html_form') {
        throw new Error('Invalid API type for form rendering');
    }
    if (stepConfig.api === 'dynamic_form') {
        const formRenderUrl = `${process.env.BASE_URL}/forms/${domain}/${formId}?transaction_id=${getFormQueryData.transaction_id}&session_id=${getFormQueryData.session_id}&direct=true`;
        if (!getFormQueryData.direct) {
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
    const newContent = ejs.render(htmlContent, {
        actionUrl: submitUrl,
        submissionData: JSON.stringify(submissionData),
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
    if (stepConfig.api !== 'dynamic_form' && stepConfig.api != 'html_form') {
        throw new Error('Invalid API type for form rendering');
    }
    const submissionID = randomUUID();
    formData.form_submission_id = submissionID;
    if (stepConfig.api === 'dynamic_form') {
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
            body {
              font-family: system-ui, -apple-system, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .success-container {
              text-align: center;
              background: white;
              padding: 3rem;
              border-radius: 1rem;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              max-width: 500px;
            }
            .success-icon {
              font-size: 4rem;
              color: #10b981;
              margin-bottom: 1rem;
              animation: scaleIn 0.5s ease-out;
            }
            h1 {
              color: #1f2937;
              margin-bottom: 0.5rem;
            }
            p {
              color: #6b7280;
              margin-bottom: 2rem;
            }
            .submission-id {
              background: #f3f4f6;
              padding: 0.75rem;
              border-radius: 0.5rem;
              font-family: monospace;
              font-size: 0.875rem;
              color: #374151;
              margin-bottom: 1.5rem;
            }
            button {
              background: #667eea;
              color: white;
              border: none;
              padding: 0.75rem 2rem;
              border-radius: 0.5rem;
              font-size: 1rem;
              cursor: pointer;
              transition: background 0.2s;
            }
            button:hover {
              background: #5568d3;
            }
            @keyframes scaleIn {
              from {
                transform: scale(0);
              }
              to {
                transform: scale(1);
              }
            }
          </style>
          <script>
            // Auto-close after 5 seconds
            setTimeout(function() {
              window.close();
            }, 5000);
          </script>
        </head>
        <body>
          <div class="success-container">
            <div class="success-icon">✓</div>
            <h1>Form Submitted Successfully!</h1>
            <p>Your form has been submitted and the flow will continue automatically.</p>
            <div class="submission-id">
              Submission ID: ${submissionID}
            </div>
            <p style="font-size: 0.875rem; color: #9ca3af;">
              This window will close automatically in 5 seconds...
            </p>
            <button onclick="window.close()">Close Window</button>
          </div>
        </body>
        </html>
      `;
