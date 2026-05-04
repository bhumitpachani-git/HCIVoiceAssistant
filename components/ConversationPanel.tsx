"use client";

import { useEffect, useRef } from "react";
import type { ConversationMessage } from "@/lib/types";

type ConversationPanelProps = {
  messages: ConversationMessage[];
};

export function ConversationPanel({ messages }: ConversationPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }

    list.scrollTop = list.scrollHeight;
  }, [messages]);

  return (
    <section className="conversation-panel" aria-label="Conversation">
      <div className="panel-header">
        <h2>Conversation</h2>
      </div>

      {messages.length === 0 ? (
        <div className="empty-state">
          <p>Start the session, turn on the mic, and talk naturally.</p>
          <p>You can say things like “smart admit the patient”, “turn on the water call”, or “start the meeting on the whiteboard”.</p>
        </div>
      ) : (
        <div className="message-list" ref={listRef}>
          {messages.map((message) => (
            <article className={`message ${message.role}${message.isPartial ? " partial" : ""}`} key={message.id}>
              <span className="message-role">{message.role}</span>
              {message.text}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
