//! The messages this device has not sent yet, one file per chat in the app data folder, so a draft written while the
//! computer is out of reach survives a relaunch. A draft whose send went out but was not confirmed keeps that send's
//! revision, so the window settles it with the computer before it offers the draft again.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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

/// The folder of drafts. The app sets it up from its data folder at start.
pub struct Drafts {
    dir: PathBuf,
}

impl Drafts {
    pub fn new(dir: PathBuf) -> Self {
        Drafts { dir }
    }

    /// The draft's file, named by the SHA-256 of the project id's UTF-8 bytes in lowercase hex, so every id, however
    /// long or whatever it holds, names one file of 64 characters in the folder and none outside it. An empty id is
    /// refused.
    fn file(&self, project: &str) -> Result<PathBuf, Error> {
        if project.is_empty() {
            return Err(Error::Project(project.into()));
        }
        let name: String = Sha256::digest(project.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(self.dir.join(format!("{name}.json")))
    }

    pub fn load(&self, project: &str) -> Result<Option<Draft>, Error> {
        match fs::read(self.file(project)?) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    /// Saves the draft whole, through a temporary file and a rename, so a crash leaves the old draft or the new one.
    /// An empty draft with no send removes the file.
    pub fn save(&self, project: &str, draft: &Draft) -> Result<(), Error> {
        let file = self.file(project)?;
        if draft.is_empty() {
            return remove(&file);
        }
        fs::create_dir_all(&self.dir)?;
        let temp = file.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_vec(draft)?)?;
        fs::rename(&temp, &file)?;
        Ok(())
    }

    /// Removes every draft, as when the device forgets its computer.
    pub fn clear(&self) -> Result<(), Error> {
        match fs::remove_dir_all(&self.dir) {
            Err(err) if err.kind() != ErrorKind::NotFound => Err(err.into()),
            _ => Ok(()),
        }
    }
}

fn remove(file: &Path) -> Result<(), Error> {
    match fs::remove_file(file) {
        Err(err) if err.kind() != ErrorKind::NotFound => Err(err.into()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn draft_load(project: String, drafts: tauri::State<'_, Drafts>) -> Result<Option<Draft>, Error> {
    drafts.load(&project)
}

#[tauri::command]
pub fn draft_save(project: String, draft: Draft, drafts: tauri::State<'_, Drafts>) -> Result<(), Error> {
    drafts.save(&project, &draft)
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

    #[test]
    fn a_saved_draft_reads_back_whole() {
        let drafts = drafts("round-trip");
        assert_eq!(drafts.load("2026-11-24-desk-clip").expect("a load"), None);
        drafts.save("2026-11-24-desk-clip", &photo()).expect("a save");
        assert_eq!(drafts.load("2026-11-24-desk-clip").expect("a load"), Some(photo()));
        // The temporary file the save wrote first is gone.
        assert_eq!(fs::read_dir(&drafts.dir).expect("the folder").count(), 1);
    }

    #[test]
    fn an_empty_draft_with_no_send_removes_the_file() {
        let drafts = drafts("empty");
        drafts.save("desk-clip", &photo()).expect("a save");
        let empty = Draft { text: String::new(), pictures: vec![], sent: None };
        drafts.save("desk-clip", &empty).expect("a save");
        assert_eq!(fs::read_dir(&drafts.dir).expect("the folder").count(), 0);
        assert_eq!(drafts.load("desk-clip").expect("a load"), None);
        // An empty draft that still waits on a send's answer is kept.
        let unconfirmed = Draft { sent: Some(Sent { rev: 7 }), ..empty };
        drafts.save("desk-clip", &unconfirmed).expect("a save");
        assert_eq!(drafts.load("desk-clip").expect("a load"), Some(unconfirmed));
    }

    #[test]
    fn any_project_id_keeps_its_draft_in_the_folder() {
        let drafts = drafts("ids");
        let long = "p".repeat(124);
        for project in ["Desk Clip", "../escape", "a/b", "..", "-flag", "x.json", "Ünïcode clip", &long] {
            drafts.save(project, &photo()).expect(project);
            assert_eq!(drafts.load(project).expect(project), Some(photo()), "{project}");
        }
        assert_eq!(drafts.load("desk clip").expect("a load"), None);
        let names: Vec<_> = fs::read_dir(&drafts.dir).expect("the folder").map(|entry| entry.expect("an entry").file_name()).collect();
        assert_eq!(names.len(), 8);
        assert!(drafts.dir.join("31a548c4ae36a1ac97c5c1033ef6128947b6a47c20bb96d3cd24dc6753c58a87.json").exists());
        assert!(drafts.dir.join("1ba7343c47dc442de7dec43a995deb9a7b62234ecca16d7c6f597b5155bd85b1.json").exists());
        assert!(!drafts.dir.parent().expect("a parent").join("escape.json").exists());
    }

    #[test]
    fn an_empty_project_id_names_no_file() {
        let drafts = drafts("refused");
        assert!(matches!(drafts.save("", &photo()), Err(Error::Project(_))));
        assert!(matches!(drafts.load(""), Err(Error::Project(_))));
    }

    #[test]
    fn clear_removes_every_draft() {
        let drafts = drafts("clear");
        drafts.save("one", &photo()).expect("a save");
        drafts.save("two", &photo()).expect("a save");
        drafts.clear().expect("a clear");
        assert_eq!((drafts.load("one").expect("a load"), drafts.load("two").expect("a load")), (None, None));
        drafts.clear().expect("a second clear");
    }
}
