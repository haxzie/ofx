use crate::error::Result;
use async_trait::async_trait;

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

/// Streaming response body.
///
/// Split out from the client so each host can supply its natural source —
/// `reqwest`'s byte stream natively, a `ReadableStream` reader in the browser.
#[async_trait(?Send)]
pub trait ByteStream {
    /// The next chunk of body bytes, or `None` at end of stream.
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>>;
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Box<dyn ByteStream>,
}

/// The one piece of I/O the core needs from its host besides the workspace.
///
/// `?Send` throughout: wasm futures are not `Send`, and requiring it would make
/// the core unusable in the browser.
#[async_trait(?Send)]
pub trait HttpClient {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse>;
}
