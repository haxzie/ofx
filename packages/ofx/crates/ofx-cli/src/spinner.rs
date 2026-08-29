use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Rotated so a long turn does not read as a frozen spinner.
const PHRASES: [&str; 20] = [
    "Thinking",
    "Pondering",
    "Reasoning",
    "Working it out",
    "Mulling it over",
    "Cooking",
    "Crunching",
    "Noodling",
    "Percolating",
    "Chewing on it",
    "Connecting the dots",
    "Sketching a plan",
    "Weighing options",
    "Digging through context",
    "Untangling this",
    "Composing a response",
    "Piecing it together",
    "Deliberating",
    "Spinning up an answer",
    "Brewing a reply",
];

/// How long a phrase stays up before another is chosen.
const PHRASE_TICKS: usize = 40;

/// Cheap PRNG: a spinner phrase does not warrant a dependency.
///
/// The clock alone is a poor source here — successive calls land microseconds
/// apart — so a counter is mixed in and the high bits are folded down, rather
/// than taking a modulus that would only ever see the low ones.
fn pseudo_random(max: usize) -> usize {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let seed = nanos ^ (COUNTER.fetch_add(1, Ordering::Relaxed) as u64).wrapping_mul(0x9E37_79B9);
    // splitmix64 finalizer: cheap, and mixes high bits into low.
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    (z % max as u64) as usize
}

struct State {
    /// Drawing right now.
    active: AtomicBool,
    /// Asks the thread to exit.
    quit: AtomicBool,
    phrase: AtomicUsize,
}

/// An animated "thinking" line, drawn while a turn waits on the model or a
/// tool.
///
/// A background thread owns the animation, so the agent loop is never blocked
/// by it. Both the thread and the renderer take the same output lock, which is
/// what keeps a frame from landing in the middle of streamed text.
pub struct Spinner {
    state: Arc<State>,
    out: Arc<Mutex<()>>,
    handle: Option<JoinHandle<()>>,
    enabled: bool,
}

impl Spinner {
    pub fn new(out: Arc<Mutex<()>>) -> Self {
        // Nothing to animate when output is piped to a file.
        let enabled = std::io::stdout().is_terminal();
        let state = Arc::new(State {
            active: AtomicBool::new(false),
            quit: AtomicBool::new(false),
            phrase: AtomicUsize::new(0),
        });

        let handle = enabled.then(|| {
            let state = Arc::clone(&state);
            let out = Arc::clone(&out);
            thread::spawn(move || {
                let mut frame = 0usize;
                let mut started = Instant::now();
                let mut drawing = false;
                let mut ticks = 0usize;

                while !state.quit.load(Ordering::Relaxed) {
                    if state.active.load(Ordering::Relaxed) {
                        if !drawing {
                            started = Instant::now();
                            drawing = true;
                            ticks = 0;
                        }
                        // A long wait cycles through phrases rather than
                        // sitting on one, which is what makes it read as
                        // progress instead of a stuck spinner.
                        ticks += 1;
                        if ticks.is_multiple_of(PHRASE_TICKS) {
                            state
                                .phrase
                                .store(pseudo_random(PHRASES.len()), Ordering::Relaxed);
                        }
                        let phrase = PHRASES[state.phrase.load(Ordering::Relaxed) % PHRASES.len()];
                        let elapsed = started.elapsed().as_secs();
                        {
                            let _guard = out.lock().unwrap_or_else(|e| e.into_inner());
                            let mut stdout = std::io::stdout();
                            // \x1b[2m dim, \x1b[36m cyan for the glyph.
                            let _ = write!(
                                stdout,
                                "\r\x1b[K\x1b[36m{}\x1b[0m \x1b[2m{}… ({}s)\x1b[0m",
                                FRAMES[frame % FRAMES.len()],
                                phrase,
                                elapsed
                            );
                            let _ = stdout.flush();
                        }
                        frame = frame.wrapping_add(1);
                    } else {
                        drawing = false;
                    }
                    thread::sleep(Duration::from_millis(90));
                }
            })
        });

        Self {
            state,
            out,
            handle,
            enabled,
        }
    }

    /// Begin animating, on a freshly chosen phrase.
    pub fn start(&self) {
        if !self.enabled {
            return;
        }
        self.state
            .phrase
            .store(pseudo_random(PHRASES.len()), Ordering::Relaxed);
        self.state.active.store(true, Ordering::Relaxed);
    }

    /// Stop animating and erase the line, so output starts from column zero.
    pub fn stop(&self) {
        if !self.enabled || !self.state.active.swap(false, Ordering::Relaxed) {
            return;
        }
        let _guard = self.out.lock().unwrap_or_else(|e| e.into_inner());
        let mut stdout = std::io::stdout();
        let _ = write!(stdout, "\r\x1b[K");
        let _ = stdout.flush();
    }
}

impl Drop for Spinner {
    fn drop(&mut self) {
        self.stop();
        self.state.quit.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
