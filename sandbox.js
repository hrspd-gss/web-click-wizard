window.parent.postMessage({ type: 'SANDBOX_READY' }, '*');

window.addEventListener('message', async (event) => {
    // Only accept messages from our extension's offscreen document
    // Actually, in MV3 sandbox page is still loaded from extension origin but we use postMessage
    const data = event.data;
    if (data && data.type === 'EXECUTE_SCRIPT') {
        const { id, script, previousResult, inputData, variables } = data;
        try {
            // 使用 new Function 來建立並執行動態程式碼
            // 腳本會接收三個參數：result, inputData, variables
            const scriptFunction = new Function('result', 'inputData', 'variables', `
                "use strict";
                ${script}
            `);

            let result = scriptFunction(previousResult, inputData, variables);

            // 處理 Promise 結果
            if (result instanceof Promise) {
                result = await result;
            }

            // 將結果傳回給 offscreen
            event.source.postMessage({
                id,
                type: 'SANDBOX_SCRIPT_RESULT',
                success: true,
                data: result,
                inputData, // Return potentially modified inputs
                variables  // Return potentially modified variables
            }, event.origin);
        } catch (error) {
            event.source.postMessage({
                id,
                type: 'SANDBOX_SCRIPT_RESULT',
                success: false,
                error: error.message || '腳本執行發生未知錯誤'
            }, event.origin);
        }
    }
});
