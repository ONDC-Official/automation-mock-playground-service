export function getBeautifulForm(rawFormHtml: string) {
    // Extract the form element from raw HTML
    const formMatch = rawFormHtml.match(/<form[\s\S]*?<\/form>/i);
    const formContent = formMatch ? formMatch[0] : rawFormHtml;

    // Extract title from the raw HTML or use default
    const titleMatch = rawFormHtml.match(/<title>(.*?)<\/title>/i);
    const formTitle = titleMatch ? titleMatch[1] : 'Form';

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${formTitle}</title>
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
        
        .form-container {
          background: #ffffff;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(14, 165, 233, 0.15);
          max-width: 900px;
          width: 100%;
          overflow: hidden;
          animation: fadeIn 0.5s ease-out;
          border: 1px solid rgba(14, 165, 233, 0.1);
        }
        
        .form-header {
          background: linear-gradient(135deg, #0ea5e9, #06b6d4);
          padding: 1.5rem 1.5rem;
          color: white;
          border-bottom: 3px solid #0072ab;
        }
        
        .form-header h1 {
          font-size: 1.2rem;
          font-weight: 600;
          margin-bottom: 0.25rem;
          letter-spacing: -0.01em;
        }
        
        .form-subtitle {
          font-size: 1rem;
          font-weight: 500;
          letter-spacing: 0.3px;
        }
        
        .form-body {
          padding: 2.5rem;
        }
        
        form {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1.5rem;
        }
        
        .form-group {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        
        .form-group.full-width {
          grid-column: 1 / -1;
        }
        
        label {
          color: #334155;
          font-size: 0.875rem;
          font-weight: 600;
          display: block;
        }
        
        input[type="text"],
        input[type="email"],
        input[type="number"],
        input[type="tel"],
        select {
          width: 100%;
          padding: 0.75rem 1rem;
          border: 1.5px solid #e2e8f0;
          border-radius: 6px;
          font-size: 0.9375rem;
          color: #1e293b;
          background: #ffffff;
          transition: all 0.2s ease;
          font-family: inherit;
          outline: none;
        }
        
        input[type="text"]:focus,
        input[type="email"]:focus,
        input[type="number"]:focus,
        input[type="tel"]:focus,
        select:focus {
          border-color: #0ea5e9;
          box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.08);
        }
        
        input[type="text"]:hover,
        input[type="email"]:hover,
        input[type="number"]:hover,
        input[type="tel"]:hover,
        select:hover {
          border-color: #94a3b8;
        }
        
        select {
          cursor: pointer;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath fill='%2364748b' d='M4 6l4 4 4-4z'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 0.75rem center;
          padding-right: 2.5rem;
          appearance: none;
        }
        
        input::placeholder {
          color: #94a3b8;
        }
        
        .submit-container {
          grid-column: 1 / -1;
          margin-top: 1rem;
          display: flex;
          gap: 1rem;
          justify-content: flex-end;
        }
        
        input[type="submit"],
        button[type="submit"] {
          background: linear-gradient(135deg, #0ea5e9, #06b6d4);
          color: white;
          border: none;
          padding: 0.75rem 2rem;
          border-radius: 6px;
          font-size: 0.9375rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          box-shadow: 0 2px 8px rgba(14, 165, 233, 0.25);
        }
        
        input[type="submit"]:hover,
        button[type="submit"]:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
          background: linear-gradient(135deg, #0284c7, #0891b2);
        }
        
        input[type="submit"]:active,
        button[type="submit"]:active {
          transform: translateY(0);
        }
        
        /* Field validation states */
        input:invalid:not(:placeholder-shown) {
          border-color: #ef4444;
        }
        
        input:valid:not(:placeholder-shown) {
          border-color: #10b981;
        }
        
        /* Loading state */
        .loading {
          pointer-events: none;
          opacity: 0.6;
        }
        
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        /* Responsive breakpoints */
        @media (max-width: 768px) {
          form {
            grid-template-columns: 1fr;
          }
          
          .form-body {
            padding: 2rem 1.5rem;
          }
          
          .form-header {
            padding: 1.25rem 1.5rem;
          }
          
          .form-header h1 {
            font-size: 1.25rem;
          }
          
          .submit-container {
            justify-content: stretch;
          }
          
          input[type="submit"],
          button[type="submit"] {
            width: 100%;
          }
        }
        
        @media (max-width: 480px) {
          body {
            padding: 1rem 0.5rem;
          }
          
          .form-body {
            padding: 1.5rem 1rem;
          }
        }
      </style>
      <script>
        document.addEventListener('DOMContentLoaded', function() {
          const form = document.querySelector('form');
          if (!form) return;
          
          // Store submit button first before processing
          const submitButton = form.querySelector('input[type="submit"], button[type="submit"]');
          
          // Intelligent field grouping and wrapping
          const processFormFields = () => {
            const elements = Array.from(form.children);
            const groups = [];
            let currentGroup = [];
            
            elements.forEach((element) => {
              // Skip submit buttons in this loop
              if (element.type === 'submit') {
                return;
              }
              
              if (element.tagName === 'LABEL') {
                if (currentGroup.length > 0) {
                  groups.push(currentGroup);
                  currentGroup = [];
                }
                currentGroup.push(element);
              } else if (element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA') {
                currentGroup.push(element);
              }
            });
            
            if (currentGroup.length > 0) {
              groups.push(currentGroup);
            }
            
            // Clear form
            form.innerHTML = '';
            
            // Rebuild with proper structure
            groups.forEach(group => {
              const label = group.find(el => el.tagName === 'LABEL');
              const input = group.find(el => el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
              
              if (label && input) {
                const wrapper = document.createElement('div');
                wrapper.className = 'form-group';
                
                // Determine if field should be full width
                const fieldName = (input.name || input.id || '').toLowerCase();
                if (fieldName.includes('address') || 
                    fieldName.includes('description') || 
                    fieldName.includes('comment') || 
                    fieldName.includes('message') ||
                    input.tagName === 'TEXTAREA') {
                  wrapper.classList.add('full-width');
                }
                
                wrapper.appendChild(label);
                wrapper.appendChild(input);
                form.appendChild(wrapper);
              }
            });
            
            // Always add submit button at the end
            if (submitButton) {
              const submitContainer = document.createElement('div');
              submitContainer.className = 'submit-container';
              submitContainer.appendChild(submitButton);
              form.appendChild(submitContainer);
            }
          };
          
          // Auto-detect and set input types
          const enhanceInputTypes = () => {
            const inputs = form.querySelectorAll('input[type="text"]');
            inputs.forEach(input => {
              const name = (input.name || input.id || '').toLowerCase();
              
              if (name.includes('email')) {
                input.type = 'email';
                input.placeholder = 'your.email@example.com';
              } else if (name.includes('phone') || name.includes('mobile')) {
                input.type = 'tel';
                input.placeholder = '+1 (555) 123-4567';
              } else if (name.includes('age')) {
                input.type = 'number';
                input.min = '1';
                input.max = '120';
                input.placeholder = 'Enter your age';
              } else if (name.includes('name')) {
                input.placeholder = 'Enter your name';
              } else if (name.includes('country')) {
                input.placeholder = 'Enter country';
              }
            });
          };
          
          // Process form
          processFormFields();
          enhanceInputTypes();
          
          // Add form submission handler
          form.addEventListener('submit', function(e) {
            const submitBtn = form.querySelector('input[type="submit"], button[type="submit"]');
            if (submitBtn) {
              submitBtn.classList.add('loading');
              const originalValue = submitBtn.value;
              submitBtn.value = 'Submitting...';
            }
          });
          
          // Add real-time validation feedback
          const inputs = form.querySelectorAll('input, select, textarea');
          inputs.forEach(input => {
            if (input.type !== 'submit') {
              input.addEventListener('blur', function() {
                if (this.value && !this.validity.valid) {
                  this.classList.add('error');
                } else {
                  this.classList.remove('error');
                }
              });
            }
          });
        });
      </script>
    </head>
    <body>
      <div class="form-container">
        <div class="form-header">
          <h1>${formTitle}</h1>
          <div class="form-subtitle">ONDC Protocol Workbench · Dynamic Forms</div>
        </div>
        <div class="form-body">
          ${formContent}
        </div>
      </div>
    </body>
    </html>
  `;
}
