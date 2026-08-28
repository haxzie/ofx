use async_trait::async_trait;
use js_sys::{Reflect, Uint8Array};
use ofx_core::error::{OfxError, Result};
use ofx_core::http::{ByteStream, HttpClient, HttpRequest, HttpResponse};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{AbortSignal, Headers, ReadableStreamDefaultReader, RequestInit, Response};

fn js_err(value: JsValue) -> OfxError {
    let detail = value
        .dyn_ref::<js_sys::Error>()
        .map(|e| String::from(e.message()))
        .or_else(|| value.as_string())
        .unwrap_or_else(|| format!("{value:?}"));
    OfxError::Http(detail)
}

/// Browser HTTP via `fetch`.
///
/// The `fetch` implementation is resolved from the global scope rather than
/// `window`, so this also works inside a worker; a host that needs to proxy
/// requests can pass its own function instead.
pub struct FetchClient {
    fetch: js_sys::Function,
    /// Applied to every request for the current turn, so aborting it stops the
    /// in-flight model call rather than waiting for the stream to finish.
    signal: RefCell<Option<AbortSignal>>,
}

impl FetchClient {
    /// Use a caller-supplied `fetch`, or fall back to the global one.
    pub fn new(custom: Option<js_sys::Function>) -> Result<Self> {
        if let Some(fetch) = custom {
            return Ok(Self {
                fetch,
                signal: RefCell::new(None),
            });
        }
        let global = js_sys::global();
        let fetch = Reflect::get(&global, &JsValue::from_str("fetch"))
            .map_err(js_err)?
            .dyn_into::<js_sys::Function>()
            .map_err(|_| OfxError::Http("no global fetch in this environment".into()))?;
        Ok(Self {
            fetch,
            signal: RefCell::new(None),
        })
    }

    /// Set (or clear) the abort signal applied to subsequent requests.
    pub fn set_signal(&self, signal: Option<AbortSignal>) {
        *self.signal.borrow_mut() = signal;
    }
}

/// Pulls chunks from a `ReadableStream` reader.
struct StreamReader {
    reader: ReadableStreamDefaultReader,
}

#[async_trait(?Send)]
impl ByteStream for StreamReader {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
        let result = JsFuture::from(self.reader.read()).await.map_err(js_err)?;

        let done = Reflect::get(&result, &JsValue::from_str("done"))
            .map_err(js_err)?
            .as_bool()
            .unwrap_or(false);
        if done {
            return Ok(None);
        }

        let value = Reflect::get(&result, &JsValue::from_str("value")).map_err(js_err)?;
        if value.is_undefined() || value.is_null() {
            // A chunk-less read that is not `done` simply yields nothing.
            return Ok(Some(Vec::new()));
        }
        Ok(Some(Uint8Array::new(&value).to_vec()))
    }
}

/// A body that was already fully buffered — used when a response has no
/// readable stream (an error page, or a polyfilled fetch).
struct BufferedBody(Option<Vec<u8>>);

#[async_trait(?Send)]
impl ByteStream for BufferedBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
        Ok(self.0.take())
    }
}

#[async_trait(?Send)]
impl HttpClient for FetchClient {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
        let headers = Headers::new().map_err(js_err)?;
        for (name, value) in &request.headers {
            headers.append(name, value).map_err(js_err)?;
        }

        let init = RequestInit::new();
        init.set_method(request.method);
        init.set_headers(&headers);
        init.set_body(&JsValue::from_str(&request.body));
        if let Some(signal) = self.signal.borrow().as_ref() {
            init.set_signal(Some(signal));
        }

        let promise = self
            .fetch
            .call2(&JsValue::NULL, &JsValue::from_str(&request.url), &init)
            .map_err(js_err)?
            .dyn_into::<js_sys::Promise>()
            .map_err(|_| OfxError::Http("fetch did not return a promise".into()))?;

        let response: Response = JsFuture::from(promise)
            .await
            .map_err(js_err)?
            .dyn_into()
            .map_err(|_| OfxError::Http("fetch did not resolve to a Response".into()))?;

        let status = response.status();

        let body: Box<dyn ByteStream> = match response.body() {
            Some(stream) => {
                let reader = stream
                    .get_reader()
                    .dyn_into::<ReadableStreamDefaultReader>()
                    .map_err(|_| OfxError::Http("response body reader unavailable".into()))?;
                Box::new(StreamReader { reader })
            }
            None => {
                let text = JsFuture::from(response.text().map_err(js_err)?)
                    .await
                    .map_err(js_err)?
                    .as_string()
                    .unwrap_or_default();
                Box::new(BufferedBody(Some(text.into_bytes())))
            }
        };

        Ok(HttpResponse { status, body })
    }
}
