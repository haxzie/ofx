/// One decoded server-sent event.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseEvent {
    /// The `event:` field, when the provider sets one. Anthropic does; OpenAI
    /// and Gemini do not.
    pub event: Option<String>,
    /// Concatenated `data:` lines.
    pub data: String,
}

impl SseEvent {
    /// OpenAI signals end-of-stream with the literal payload `[DONE]`.
    pub fn is_done_sentinel(&self) -> bool {
        self.data.trim() == "[DONE]"
    }
}

/// Incremental `text/event-stream` decoder.
///
/// Network chunks split anywhere — mid-line, mid-UTF-8 — so bytes are buffered
/// until a complete event (terminated by a blank line) is available.
#[derive(Debug, Default)]
pub struct SseParser {
    /// Raw bytes not yet forming a complete line.
    buffer: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of the response body, returning any events it completed.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();

        // Split on \n; a trailing \r is stripped so CRLF streams work too.
        while let Some(pos) = self.buffer.iter().position(|&b| b == b'\n') {
            let mut line = self.buffer.drain(..=pos).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            // Lossy is right here: a malformed byte must not kill the stream.
            if let Some(event) = self.push_line(&String::from_utf8_lossy(&line)) {
                events.push(event);
            }
        }
        events
    }

    /// Flush a final event that arrived without its terminating blank line.
    pub fn finish(&mut self) -> Option<SseEvent> {
        if !self.buffer.is_empty() {
            let rest = std::mem::take(&mut self.buffer);
            let line = String::from_utf8_lossy(&rest).to_string();
            if let Some(event) = self.push_line(&line) {
                return Some(event);
            }
        }
        self.take_event()
    }

    fn push_line(&mut self, line: &str) -> Option<SseEvent> {
        // A blank line dispatches the accumulated event.
        if line.is_empty() {
            return self.take_event();
        }
        // Lines beginning with a colon are comments (often keep-alives).
        if line.starts_with(':') {
            return None;
        }

        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };

        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            // `id` and `retry` carry no meaning for our providers.
            _ => {}
        }
        None
    }

    fn take_event(&mut self) -> Option<SseEvent> {
        if self.data.is_empty() && self.event.is_none() {
            return None;
        }
        Some(SseEvent {
            event: self.event.take(),
            data: std::mem::take(&mut self.data).join("\n"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(parser: &mut SseParser, input: &str) -> Vec<SseEvent> {
        parser.feed(input.as_bytes())
    }

    #[test]
    fn parses_a_named_event() {
        let mut p = SseParser::new();
        let events = feed_all(&mut p, "event: content_block_delta\ndata: {\"a\":1}\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.as_deref(), Some("content_block_delta"));
        assert_eq!(events[0].data, "{\"a\":1}");
    }

    #[test]
    fn parses_data_only_events() {
        let mut p = SseParser::new();
        let events = feed_all(&mut p, "data: {\"x\":1}\n\ndata: [DONE]\n\n");
        assert_eq!(events.len(), 2);
        assert!(events[0].event.is_none());
        assert!(events[1].is_done_sentinel());
    }

    #[test]
    fn reassembles_events_split_across_chunks() {
        let mut p = SseParser::new();
        assert!(p.feed(b"event: mes").is_empty());
        assert!(p.feed(b"sage_start\ndata: {\"par").is_empty());
        let events = p.feed(b"tial\":true}\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.as_deref(), Some("message_start"));
        assert_eq!(events[0].data, "{\"partial\":true}");
    }

    #[test]
    fn joins_multiple_data_lines() {
        let mut p = SseParser::new();
        let events = feed_all(&mut p, "data: line one\ndata: line two\n\n");
        assert_eq!(events[0].data, "line one\nline two");
    }

    #[test]
    fn handles_crlf_and_skips_comments() {
        let mut p = SseParser::new();
        let events = feed_all(&mut p, ": keep-alive\r\ndata: {\"ok\":true}\r\n\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"ok\":true}");
    }

    #[test]
    fn flushes_a_trailing_event_without_blank_line() {
        let mut p = SseParser::new();
        assert!(p.feed(b"data: {\"last\":1}").is_empty());
        let event = p.finish().expect("trailing event");
        assert_eq!(event.data, "{\"last\":1}");
    }

    #[test]
    fn survives_a_split_multibyte_character() {
        let mut p = SseParser::new();
        let text = "data: {\"t\":\"héllo\"}\n\n";
        let bytes = text.as_bytes();
        // Split inside the two-byte 'é'.
        let split = text.find('é').unwrap() + 1;
        assert!(p.feed(&bytes[..split]).is_empty());
        let events = p.feed(&bytes[split..]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"t\":\"héllo\"}");
    }
}
