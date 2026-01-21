const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');

let history = [];
let isLoading = false;

function setLoading(loading) {
  isLoading = loading;
  inputEl.disabled = loading;
  sendBtn.disabled = loading;
  sendBtn.textContent = loading ? '...' : 'Send';
}

function clearEmptyState() {
  const emptyState = messagesEl.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }
}

function appendMessage(role, content, className = '') {
  clearEmptyState();
  const el = document.createElement('div');
  el.className = `message ${role} ${className}`.trim();
  el.textContent = content;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

async function sendMessage() {
  const content = inputEl.value.trim();
  if (!content || isLoading) return;

  // Add user message to history and display
  history.push({ role: 'user', content });
  appendMessage('user', content);
  inputEl.value = '';

  // Create assistant message placeholder
  const assistantEl = appendMessage('assistant', '', 'typing');
  setLoading(true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });

    if (!response.ok) {
      let errorMessage = 'Something went wrong. Please try again.';
      try {
        const err = await response.json();
        if (err.error) {
          errorMessage = err.error;
        }
      } catch {
        // Use default error message
      }
      assistantEl.textContent = errorMessage;
      assistantEl.className = 'message assistant error';
      setLoading(false);
      return;
    }

    // Stream response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let assistantContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE messages
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.response) {
              assistantContent += parsed.response;
              assistantEl.textContent = assistantContent;
              assistantEl.className = 'message assistant';
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    }

    // Process any remaining buffer content
    if (buffer.startsWith('data: ')) {
      const data = buffer.slice(6).trim();
      if (data && data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.response) {
            assistantContent += parsed.response;
            assistantEl.textContent = assistantContent;
            assistantEl.className = 'message assistant';
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    // Save to history if we got content
    if (assistantContent) {
      history.push({ role: 'assistant', content: assistantContent });
    } else {
      assistantEl.textContent = 'No response received. Please try again.';
      assistantEl.className = 'message assistant error';
    }
  } catch (err) {
    console.error('Chat error:', err);
    assistantEl.textContent = 'Connection error. Please check your network and try again.';
    assistantEl.className = 'message assistant error';
  }

  setLoading(false);
  inputEl.focus();
}

// Event listeners
sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Focus input on load
inputEl.focus();
