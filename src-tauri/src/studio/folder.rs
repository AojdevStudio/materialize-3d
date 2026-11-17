//! The one rule for a path named inside a folder: a project folder, Bambu Studio's config folder, or the profile
//! folder Bambu Studio ships. A name is one or more plain folder or file names, and it must lead to a place inside the
//! folder where it really is, links followed. [`inside`] finds a path that is there. [`make_folder`] makes a folder
//! under the same rule.

use std::io;
use std::path::{Component, Path, PathBuf};

/// Why a path was refused.
#[derive(Debug)]
pub(crate) enum Refused {
    /// The name is empty or absolute, or holds `.` or `..` where a folder or file name belongs.
    NotAName,
    /// The name leads out of the folder through a symbolic link.
    LeadsOutside,
    /// The path, or the folder, is not there or could not be read.
    Unreadable(PathBuf, io::Error),
}

fn named(rel: &Path) -> Result<&Path, Refused> {
    if rel.as_os_str().is_empty() || !rel.components().all(|part| matches!(part, Component::Normal(_))) {
        return Err(Refused::NotAName);
    }
    Ok(rel)
}

fn real(path: PathBuf) -> Result<PathBuf, Refused> {
    path.canonicalize().map_err(|e| Refused::Unreadable(path, e))
}

fn contained(root: &Path, path: PathBuf) -> Result<PathBuf, Refused> {
    if path.starts_with(root) { Ok(path) } else { Err(Refused::LeadsOutside) }
}

/// Where `rel`, a file or folder that is there, really is inside `root`. The whole path is read where it leads as `rel`
/// spells it, so a trailing `/` after a file fails as it would for any reader. The path that comes back holds no link,
/// so a caller reads or serves what was checked.
pub(crate) fn inside(root: &Path, rel: impl AsRef<Path>) -> Result<PathBuf, Refused> {
    let rel = named(rel.as_ref())?;
    let root = real(root.to_owned())?;
    let path = real(root.join(rel))?;
    contained(&root, path)
}

/// Makes the folder `rel` inside `root` one level at a time, and gives where it really is. A level that is there is
/// checked where it leads before the next level goes in it. A level is made only where none is, so a link that
/// appears meanwhile fails the make instead of being followed.
pub(crate) fn make_folder(root: &Path, rel: impl AsRef<Path>) -> Result<PathBuf, Refused> {
    let rel = named(rel.as_ref())?;
    let root = real(root.to_owned())?;
    let mut folder = root.clone();
    for part in rel.components() {
        let next = folder.join(part);
        folder = match std::fs::create_dir(&next) {
            Ok(()) => next,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => contained(&root, real(next)?)?,
            Err(e) => return Err(Refused::Unreadable(next, e)),
        };
    }
    Ok(folder)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(result: Result<PathBuf, Refused>) -> Result<PathBuf, &'static str> {
        result.map_err(|refused| match refused {
            Refused::NotAName => "not a name",
            Refused::LeadsOutside => "leads outside",
            Refused::Unreadable(..) => "unreadable",
        })
    }

    struct Tree {
        around: tempfile::TempDir,
        root: PathBuf,
        real: PathBuf,
    }

    /// A folder with a file in `parts/`, a link in, links out, and a dangling link, inside a temporary folder of its own
    /// that holds a file outside it.
    #[cfg(unix)]
    fn tree() -> Tree {
        let around = tempfile::tempdir().expect("tempdir");
        let root = around.path().join("folder");
        std::fs::create_dir_all(root.join("parts")).expect("parts");
        std::fs::write(root.join("parts/arm.stl"), "").expect("arm");
        std::fs::write(around.path().join("secret.stl"), "").expect("secret");
        std::os::unix::fs::symlink(root.join("parts"), root.join("in")).expect("link in");
        std::os::unix::fs::symlink(around.path(), root.join("out")).expect("link out");
        std::os::unix::fs::symlink(around.path().join("secret.stl"), root.join("away.stl")).expect("file link out");
        std::os::unix::fs::symlink(around.path().join("gone"), root.join("dangling")).expect("dangling link");
        let real = root.canonicalize().expect("root");
        Tree { around, root, real }
    }

    const NOT_NAMES: [&str; 9] = ["", "..", "../folder/parts/arm.stl", "parts/../parts/arm.stl", "./parts/arm.stl", "/etc/passwd", "../other/a.stl", "print/../../x.3mf", "./a.stl"];

    #[cfg(unix)]
    #[test]
    fn a_path_stays_in_its_folder_by_name_and_where_it_really_leads() {
        let Tree { around, root, real } = tree();
        let at = |rel: &str| kind(inside(&root, rel));

        assert_eq!(at("parts/arm.stl"), Ok(real.join("parts/arm.stl")));
        assert_eq!(at("parts/./arm.stl"), Ok(real.join("parts/arm.stl")), "Rust drops a `.` between names");
        assert_eq!(at("in/arm.stl"), Ok(real.join("parts/arm.stl")), "a link in is read where it leads");
        assert_eq!(at("out/folder/parts/arm.stl"), Ok(real.join("parts/arm.stl")), "a path that ends inside is inside");
        assert_eq!(at("parts"), Ok(real.join("parts")));
        for name in NOT_NAMES {
            assert_eq!(at(name), Err("not a name"), "{name:?}");
        }
        for link in ["out", "out/secret.stl", "away.stl"] {
            assert_eq!(at(link), Err("leads outside"), "{link}");
        }
        for missing in ["new.3mf", "parts/new.3mf", "dangling", "parts/arm.stl/x", "parts/arm.stl/", "parts/arm.stl/."] {
            assert_eq!(at(missing), Err("unreadable"), "{missing}");
        }
        assert_eq!(kind(inside(&around.path().join("missing"), "a.stl")), Err("unreadable"));
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_is_made_only_inside_and_each_level_there_is_checked_first() {
        let Tree { around, root, real } = tree();
        let make = |rel: &str| kind(make_folder(&root, rel));

        assert_eq!(make("parts"), Ok(real.join("parts")));
        assert_eq!(make("in/new"), Ok(real.join("parts/new")), "a level made through a link in");
        assert_eq!(make("print/deeper"), Ok(real.join("print/deeper")));
        assert!(real.join("print/deeper").is_dir());
        for name in NOT_NAMES {
            assert_eq!(make(name), Err("not a name"), "{name:?}");
        }
        assert_eq!(make("out/new"), Err("leads outside"));
        assert!(!around.path().join("new").exists(), "no folder was made outside");
        assert_eq!(make("dangling/new"), Err("unreadable"));
        assert!(!around.path().join("gone").exists(), "no folder was made where a dangling link leads");
        assert_eq!(make("parts/arm.stl/new"), Err("unreadable"), "a file is no folder");
    }
}
