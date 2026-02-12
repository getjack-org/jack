import React from "react";
import { createRoot } from "react-dom/client";
import { useChat } from "@ai-sdk/react";

const { useState, useEffect, useRef } = React;

function App() {
  const [chatId, setChatId] = useState(null);
  const messagesEndRef = useRef(null);

  // Create a new chat on mount
  useEffect(() => {
    fetch("/api/chat/new", { method: "POST" })
      .then((r) => r.json())
      .then((data) => setChatId(data.id));
  }, []);

  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: "/api/chat",
    body: { chatId },
  });

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return React.createElement("div", { style: styles.container },
    React.createElement("header", { style: styles.header },
      React.createElement("h1", { style: styles.title }, "AI Chat"),
    ),
    React.createElement("div", { style: styles.messages },
      messages.length === 0 && React.createElement("div", { style: styles.empty }, "Send a message to start chatting"),
      messages.map((m) =>
        React.createElement("div", { key: m.id, style: { ...styles.message, ...(m.role === "user" ? styles.userMessage : styles.assistantMessage) } },
          React.createElement("div", { style: styles.messageRole }, m.role === "user" ? "You" : "AI"),
          React.createElement("div", { style: styles.messageContent }, m.content || (m.parts?.map(p => p.text).join("") || "")),
        )
      ),
      React.createElement("div", { ref: messagesEndRef }),
    ),
    React.createElement("form", { onSubmit: handleSubmit, style: styles.form },
      React.createElement("input", {
        value: input,
        onChange: handleInputChange,
        placeholder: "Type a message...",
        style: styles.input,
        disabled: isLoading,
      }),
      React.createElement("button", { type: "submit", style: styles.button, disabled: isLoading || !input.trim() },
        isLoading ? "..." : "Send"
      ),
    ),
  );
}

const styles = {
  container: { display: "flex", flexDirection: "column", height: "100vh", maxWidth: "800px", margin: "0 auto" },
  header: { padding: "16px 20px", borderBottom: "1px solid #262626" },
  title: { fontSize: "18px", fontWeight: "600" },
  messages: { flex: 1, overflow: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: "16px" },
  empty: { color: "#737373", textAlign: "center", marginTop: "40px" },
  message: { padding: "12px 16px", borderRadius: "12px", maxWidth: "80%" },
  userMessage: { alignSelf: "flex-end", background: "#2563eb", color: "white" },
  assistantMessage: { alignSelf: "flex-start", background: "#1c1c1c", border: "1px solid #262626" },
  messageRole: { fontSize: "11px", fontWeight: "600", marginBottom: "4px", opacity: 0.7, textTransform: "uppercase" },
  messageContent: { fontSize: "14px", lineHeight: "1.5", whiteSpace: "pre-wrap" },
  form: { padding: "16px 20px", borderTop: "1px solid #262626", display: "flex", gap: "8px" },
  input: { flex: 1, padding: "10px 14px", borderRadius: "8px", border: "1px solid #333", background: "#1c1c1c", color: "#e5e5e5", fontSize: "14px", outline: "none" },
  button: { padding: "10px 20px", borderRadius: "8px", border: "none", background: "#2563eb", color: "white", fontSize: "14px", fontWeight: "500", cursor: "pointer" },
};

createRoot(document.getElementById("root")).render(React.createElement(App));
