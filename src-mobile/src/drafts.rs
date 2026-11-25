//! The messages this device has not sent yet, one file per chat in a folder of the pairing's own under the app data
//! folder, so a draft written while the computer is out of reach survives a relaunch, and the same chat id on another
//! computer never shares it. A draft whose send went out but was not confirmed keeps that send's revision, so the
//! window settles it with the computer before it offers the draft again.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::paired::{Paired, PairingId};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Picture {
    pub name: String,
    /// The picture's bytes, base64, as the computer's draft route takes them.
    pub data: String,
}

/// A send that went out as revision `rev` of the computer's copy of this draft.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Sent {
    pub rev: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Draft {
    pub text: String,
    pub pictures: Vec<Picture>,
    pub sent: Option<Sent>,
}

impl Draft {
    fn is_empty(&self) -> bool {
        self.text.is_empty() && self.pictures.is_empty() && self.sent.is_none()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} is not a chat this device can keep a draft for.")]
    Project(String),
    #[error("This device is not paired with a computer, so it keeps no draft.")]
    Unpaired,
    #[error("This device could not keep the draft. {0}")]
    Io(#[from] std::io::Error),
    #[error("The saved draft is damaged. {0}")]
    Damaged(#[from] serde_json::Error),
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// The folder of every pairing's drafts. The app sets it up from its data folder at start.
pub struct Drafts {
    dir: PathBuf,
}

impl Drafts {
    pub fn new(dir: PathBuf) -> Self {
        Drafts { dir }
    }

    fn folder(&self, pairing: &PairingId) -> PathBuf {
        self.dir.join(pairing.as_str())
    }

    /// The draft's file in the pairing's folder, named by the SHA-256 of the project id's UTF-8 bytes in lowercase hex,
    /// so every id, however long or whatever it holds, names one file of 64 characters in the folder and none outside
    /// it. An empty id is refused.
    fn file(&self, pairing: &PairingId, project: &str) -> Result<PathBuf, Error> {
        if project.is_empty() {
            return Err(Error::Project(project.into()));
        }
        let name: String = Sha256::digest(project.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(self.folder(pairing).join(format!("{name}.json")))
    }

    pub fn load(&self, pairing: &PairingId, project: &str) -> Result<Option<Draft>, Error> {
        match fs::read(self.file(pairing, project)?) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    /// Saves the draft whole, through a temporary file and a rename, so a crash leaves the old draft or the new one.
    /// An empty draft with no send removes the file.
    pub fn save(&self, pairing: &PairingId, project: &str, draft: &Draft) -> Result<(), Error> {
        let file = self.file(pairing, project)?;
        if draft.is_empty() {
            return remove(&file);
        }
        fs::create_dir_all(self.folder(pairing))?;
        let temp = file.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_vec(draft)?)?;
        fs::rename(&temp, &file)?;
        Ok(())
    }

    /// Removes the pairing's drafts, as when the device forgets its computer. A folder that stays belongs to no
    /// pairing, so the next sweep removes it.
    pub fn remove(&self, pairing: &PairingId) {
        let _ = fs::remove_dir_all(self.folder(pairing));
    }

    /// Removes every folder and file but `keep`'s folder. `paired_computer` and `pair` sweep each time they set the
    /// pairing. This is the recovery for drafts that outlive their pairing: a Forget whose removal failed, a write that
    /// landed after its pairing was forgotten, or a Keychain that lost its pairing. An entry that fails to go stays for
    /// the next sweep.
    pub fn sweep(&self, keep: Option<&PairingId>) {
        // No folder yet means nothing to sweep.
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        for entry in entries.flatten() {
            if keep.is_some_and(|keep| entry.file_name() == keep.as_str()) {
                continue;
            }
            let path = entry.path();
            let _ = if entry.file_type().is_ok_and(|kind| kind.is_dir()) { fs::remove_dir_all(path) } else { fs::remove_file(path) };
        }
    }
}

fn remove(file: &Path) -> Result<(), Error> {
    match fs::remove_file(file) {
        Err(err) if err.kind() != ErrorKind::NotFound => Err(err.into()),
        _ => Ok(()),
    }
}

/// The drafts' pairing comes from Rust's own state, never from the window.
fn pairing(paired: &Paired) -> Result<PairingId, Error> {
    paired.current().map(|pairing| pairing.id()).ok_or(Error::Unpaired)
}

#[tauri::command]
pub fn draft_load(project: String, drafts: tauri::State<'_, Drafts>, paired: tauri::State<'_, Paired>) -> Result<Option<Draft>, Error> {
    drafts.load(&pairing(&paired)?, &project)
}

#[tauri::command]
pub fn draft_save(project: String, draft: Draft, drafts: tauri::State<'_, Drafts>, paired: tauri::State<'_, Paired>) -> Result<(), Error> {
    drafts.save(&pairing(&paired)?, &project, &draft)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drafts(name: &str) -> Drafts {
        let dir = std::env::temp_dir().join(format!("m3d-drafts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        Drafts::new(dir)
    }

    fn photo() -> Draft {
        Draft { text: "Make it 2 mm thicker".into(), pictures: vec![Picture { name: "clip.jpg".into(), data: "/9j/4AAQ".into() }], sent: Some(Sent { rev: 41 }) }
    }

    fn a() -> PairingId {
        PairingId::of("token-a")
    }

    fn b() -> PairingId {
        PairingId::of("token-b")
    }

    #[test]
    fn a_saved_draft_reads_back_whole() {
        let drafts = drafts("round-trip");
        assert_eq!(drafts.load(&a(), "2026-11-24-desk-clip").expect("a load"), None);
        drafts.save(&a(), "2026-11-24-desk-clip", &photo()).expect("a save");
        assert_eq!(drafts.load(&a(), "2026-11-24-desk-clip").expect("a load"), Some(photo()));
        // The temporary file the save wrote first is gone.
        assert_eq!(fs::read_dir(drafts.dir.join(a().as_str())).expect("the folder").count(), 1);
    }

    #[test]
    fn an_empty_draft_with_no_send_removes_the_file() {
        let drafts = drafts("empty");
        drafts.save(&a(), "desk-clip", &photo()).expect("a save");
        let empty = Draft { text: String::new(), pictures: vec![], sent: None };
        drafts.save(&a(), "desk-clip", &empty).expect("a save");
        assert_eq!(fs::read_dir(drafts.dir.join(a().as_str())).expect("the folder").count(), 0);
        assert_eq!(drafts.load(&a(), "desk-clip").expect("a load"), None);
        // An empty draft that still waits on a send's answer is kept.
        let unconfirmed = Draft { sent: Some(Sent { rev: 7 }), ..empty };
        drafts.save(&a(), "desk-clip", &unconfirmed).expect("a save");
        assert_eq!(drafts.load(&a(), "desk-clip").expect("a load"), Some(unconfirmed));
    }

    #[test]
    fn any_project_id_keeps_its_draft_in_the_folder() {
        let drafts = drafts("ids");
        let long = "p".repeat(124);
        for project in ["Desk Clip", "../escape", "a/b", "..", "-flag", "x.json", "Ünïcode clip", &long] {
            drafts.save(&a(), project, &photo()).expect(project);
            assert_eq!(drafts.load(&a(), project).expect(project), Some(photo()), "{project}");
        }
        assert_eq!(drafts.load(&a(), "desk clip").expect("a load"), None);
        let folder = drafts.dir.join(a().as_str());
        let names: Vec<_> = fs::read_dir(&folder).expect("the folder").map(|entry| entry.expect("an entry").file_name()).collect();
        assert_eq!(names.len(), 8);
        assert!(folder.join("31a548c4ae36a1ac97c5c1033ef6128947b6a47c20bb96d3cd24dc6753c58a87.json").exists());
        assert!(folder.join("1ba7343c47dc442de7dec43a995deb9a7b62234ecca16d7c6f597b5155bd85b1.json").exists());
        assert!(!folder.parent().expect("a parent").join("escape.json").exists());
    }

    #[test]
    fn an_empty_project_id_names_no_file() {
        let drafts = drafts("refused");
        assert!(matches!(drafts.save(&a(), "", &photo()), Err(Error::Project(_))));
        assert!(matches!(drafts.load(&a(), ""), Err(Error::Project(_))));
    }

    #[test]
    fn the_same_chat_id_on_two_computers_keeps_two_drafts() {
        let drafts = drafts("pairings");
        drafts.save(&a(), "desk-clip", &photo()).expect("a save");
        assert_eq!(drafts.load(&b(), "desk-clip").expect("a load"), None);
        let other = Draft { text: "Make it blue".into(), pictures: vec![], sent: None };
        drafts.save(&b(), "desk-clip", &other).expect("a save");
        assert_eq!((drafts.load(&a(), "desk-clip").expect("a load"), drafts.load(&b(), "desk-clip").expect("a load")), (Some(photo()), Some(other)));
    }

    #[test]
    fn remove_takes_one_pairing_and_leaves_the_other() {
        let drafts = drafts("remove");
        drafts.save(&a(), "desk-clip", &photo()).expect("a save");
        drafts.save(&b(), "desk-clip", &photo()).expect("a save");
        drafts.remove(&a());
        assert_eq!((drafts.load(&a(), "desk-clip").expect("a load"), drafts.load(&b(), "desk-clip").expect("a load")), (None, Some(photo())));
        drafts.remove(&a());
    }

    #[test]
    fn a_sweep_keeps_only_the_current_pairing() {
        let drafts = drafts("sweep");
        // Nothing saved yet, so there is no folder to sweep.
        drafts.sweep(Some(&a()));
        drafts.save(&a(), "desk-clip", &photo()).expect("a save");
        drafts.save(&b(), "desk-clip", &photo()).expect("a save");
        // A draft file from before drafts belonged to a pairing.
        fs::write(drafts.dir.join("31a548c4ae36a1ac97c5c1033ef6128947b6a47c20bb96d3cd24dc6753c58a87.json"), b"{}").expect("a loose file");

        drafts.sweep(Some(&b()));
        let names: Vec<_> = fs::read_dir(&drafts.dir).expect("the folder").map(|entry| entry.expect("an entry").file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from(b().as_str())]);
        assert_eq!(drafts.load(&b(), "desk-clip").expect("a load"), Some(photo()));

        drafts.sweep(None);
        assert_eq!(fs::read_dir(&drafts.dir).expect("the folder").count(), 0);
    }
}
