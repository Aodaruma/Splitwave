//! Display demand lives off the audio thread. Hidden monitors keep their DSP history.
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct MonitorTargets {
    nodes: Mutex<Arc<HashSet<String>>>,
    visible: AtomicBool,
}

impl Default for MonitorTargets {
    fn default() -> Self {
        Self {
            nodes: Mutex::new(Arc::new(HashSet::new())),
            visible: AtomicBool::new(true),
        }
    }
}

impl MonitorTargets {
    pub fn replace(&self, nodes: Vec<String>) {
        *self.nodes.lock().unwrap() = Arc::new(nodes.into_iter().collect());
    }

    pub fn set_visible(&self, visible: bool) {
        self.visible.store(visible, Ordering::Relaxed);
    }

    /// Called only by the non-RT meter tick, once per batch.
    pub fn snapshot(&self) -> Option<Arc<HashSet<String>>> {
        self.visible
            .load(Ordering::Relaxed)
            .then(|| self.nodes.lock().unwrap().clone())
    }
}

#[tauri::command]
pub fn set_monitor_targets(state: tauri::State<'_, MonitorTargets>, node_ids: Vec<String>) {
    state.replace(node_ids);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hiding_retains_subscriptions_and_snapshots_are_stable() {
        let state = MonitorTargets::default();
        assert!(state.snapshot().unwrap().is_empty());
        state.replace(vec!["scope".into(), "scope".into(), "lufs".into()]);
        let before = state.snapshot().unwrap();
        assert_eq!(before.len(), 2);
        state.set_visible(false);
        assert!(state.snapshot().is_none());
        state.replace(vec!["other".into()]);
        state.set_visible(true);
        assert!(state.snapshot().unwrap().contains("other"));
        assert!(before.contains("scope"));
    }
}
