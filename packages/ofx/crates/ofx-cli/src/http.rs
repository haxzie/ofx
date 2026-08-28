use async_trait::async_trait;
use futures_util::StreamExt;
use ofx_core::error::{OfxError, Result};
use ofx_core::http::{ByteStream, HttpClient, HttpRequest, HttpResponse};

pub struct ReqwestClient {
    client: reqwest::Client,
}

impl ReqwestClient {
    pub fn new() -> Result<Self> {
        reqwest::Client::builder()
            .user_agent(concat!("ofx/", env!("CARGO_PKG_VERSION")))
            .build()
            .map(|client| Self { client })
            .map_err(|e| OfxError::Http(e.to_string()))
    }
}

/// Adapts reqwest's push-based byte stream to the core's pull-based interface.
struct ResponseStream {
    inner: futures_util::stream::BoxStream<'static, Result<Vec<u8>>>,
}

#[async_trait(?Send)]
impl ByteStream for ResponseStream {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
        self.inner.next().await.transpose()
    }
}

#[async_trait(?Send)]
impl HttpClient for ReqwestClient {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| OfxError::Http(format!("unsupported method {}", request.method)))?;

        let mut builder = self.client.request(method, &request.url).body(request.body);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }

        let response = builder
            .send()
            .await
            .map_err(|e| OfxError::Http(e.to_string()))?;

        Ok(HttpResponse {
            status: response.status().as_u16(),
            // Convert to owned bytes here so the `bytes` crate never appears in
            // the core's interface.
            body: Box::new(ResponseStream {
                inner: response
                    .bytes_stream()
                    .map(|chunk| {
                        chunk
                            .map(|b| b.to_vec())
                            .map_err(|e| OfxError::Http(e.to_string()))
                    })
                    .boxed(),
            }),
        })
    }
}
