//! The test binary's global allocator: the system allocator, counting each
//! thread's live bytes and their peak, so a test can measure what one call
//! allocates. Test builds only; the app keeps the system allocator.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct Counting;

thread_local! {
    static LIVE: Cell<isize> = const { Cell::new(0) };
    static PEAK: Cell<isize> = const { Cell::new(0) };
}

fn note(delta: isize) {
    // `try_with`: an allocation while this thread's locals are torn down is not counted.
    let _ = LIVE.try_with(|live| {
        let now = live.get() + delta;
        live.set(now);
        let _ = PEAK.try_with(|peak| peak.set(peak.get().max(now)));
    });
}

// SAFETY: every call forwards to the system allocator unchanged; counting only
// touches const-initialized thread locals, which never allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            note(layout.size() as isize);
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            note(layout.size() as isize);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        note(-(layout.size() as isize));
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(ptr, layout, new_size) };
        if !moved.is_null() {
            note(new_size as isize - layout.size() as isize);
        }
        moved
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Runs `f` on this thread and returns its result and the most bytes this
/// thread held at once while it ran, beyond what it held when `f` started.
pub fn peak_during<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let start = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(start));
    let out = f();
    let peak = PEAK.with(Cell::get);
    (out, usize::try_from(peak - start).unwrap_or(0))
}
