// This file acts as a bridge between the Service Worker and the Sandboxed page
const frame = document.getElementById('sandbox-frame');

let isSandboxReady = false;

frame.addEventListener('load', () => {
    isSandboxReady = true;
});

window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SANDBOX_READY') {
        isSandboxReady = true;
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXECUTE_SANDBOX_SCRIPT') {
        const { id, script, previousResult, inputData, variables } = message;

        const execute = () => {
            // Wait for an event from the sandbox to send response back
            const handler = (event) => {
                if (event.data && event.data.type === 'SANDBOX_SCRIPT_RESULT' && event.data.id === id) {
                    window.removeEventListener('message', handler);
                    sendResponse(event.data);
                }
            };
            window.addEventListener('message', handler);

            // Send to sandbox frame
            frame.contentWindow.postMessage({
                type: 'EXECUTE_SCRIPT',
                id,
                script,
                previousResult,
                inputData,
                variables
            }, '*');
        };

        if (isSandboxReady) {
            execute();
        } else {
            const readyHandler = (event) => {
                if (event.data && event.data.type === 'SANDBOX_READY') {
                    window.removeEventListener('message', readyHandler);
                    isSandboxReady = true;
                    execute();
                }
            };
            window.addEventListener('message', readyHandler);
        }

        return true; // Indicate asynchronous response
    }
});
