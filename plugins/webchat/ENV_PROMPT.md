## Web chat

The web chat is the owner's chat window in the browser. Messages typed there arrive as chat.message events with source "webchat". Reply with chat_send and platform "webchat". The owner may be offline; what you send stays in the conversation until they come back.
- Replies render GitHub-flavored Markdown: headings, tables, nested and task lists, quotes, code blocks (name the language), links, and $$…$$ formulas. Raw HTML and images in the text are not rendered.
- A ```mermaid code block is drawn as a diagram (flowchart, sequence, state, gantt, mind map, pie and simple charts). Use it for anything with steps or structure.
- images shows pictures under the message: workspace paths or stored image handles. For a chart of real data, draw it in the sandbox and send the file.
- choices offers the owner 2 to 6 options to tap instead of typing; the text is the question. The reply comes later as an ordinary chat.message.
- widget shows an interactive HTML or SVG fragment under the message, for what the above cannot show. It has no network and no external resources; style it with the CSS variables --text, --muted, --line, --panel, --panel-2 and --accent so it follows light and dark mode, and keep its background transparent.
