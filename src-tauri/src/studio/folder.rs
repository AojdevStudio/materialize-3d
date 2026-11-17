//! The one rule for a path named inside a folder: a project folder, Bambu Studio's config folder, or the profile
//! folder Bambu Studio ships. Every path the app reads, serves, or writes for a name it was given goes through
//! [`inside`].

use std::io;
use std::path::{Component, Path, PathBuf};

/// Why [`inside`] refused a path.
#[derive(Debug)]
pub(crate) enum Refused {
    /// The name is empty or absolute, or holds `.` or `..` where a folder or file name belongs.
    NotAName,
    /// The name leads out of the folder through a symbolic link.
    LeadsOutside,
    /// The folder, or a part of the path that is there, could not be read.
    Unreadable(io::Error),
}

/// Where `rel` really is inside `root`. `rel` is a plain relative name: one or more folder or file names. Each part
/// that is there is read where it really leads, so a symbolic link that leads out of `root` is refused like a name
/// that does. The parts that are not there yet follow as named, so a file or folder can be made at the path. The path
/// that comes back starts with the real path of `root`.
pub(crate) fn inside(root: &Path, rel: impl AsRef<Path>) -> Result<PathBuf, Refused> {
    let rel = rel.as_ref();
    if rel.as_os_str().is_empty() || !rel.components().all(|part| matches!(part, Component::Normal(_))) {
        return Err(Refused::NotAName);
    }
    let root = root.canonicalize().map_err(Refused::Unreadable)?;
    let mut real = root.clone();
    let mut parts = rel.components();
    for part in parts.by_ref() {
        let next = real.join(part);
        match next.symlink_metadata() {
            Ok(_) => real = next.canonicalize().map_err(Refused::Unreadable)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                real = next;
                break;
            }
            Err(e) => return Err(Refused::Unreadable(e)),
        }
        if !real.starts_with(&root) {
            return Err(Refused::LeadsOutside);
        }
    }
    real.extend(parts);
    Ok(real)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(result: Result<PathBuf, Refused>) -> Result<PathBuf, &'static str> {
        result.map_err(|refused| match refused {
            Refused::NotAName => "not a name",
            Refused::LeadsOutside => "leads outside",
            Refused::Unreadable(_) => "unreadable",
        })
    }

    #[cfg(unix)]
    #[test]
    fn a_path_stays_in_its_folder_by_name_and_where_it_really_leads() {
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
        let at = |rel: &str| kind(inside(&root, rel));

        assert_eq!(at("parts/arm.stl"), Ok(real.join("parts/arm.stl")));
        assert_eq!(at("parts/./arm.stl"), Ok(real.join("parts/arm.stl")), "Rust drops a `.` between names");
        assert_eq!(at("in/arm.stl"), Ok(real.join("parts/arm.stl")), "a link in is read where it leads");
        assert_eq!(at("new/deeper/cube.3mf"), Ok(real.join("new/deeper/cube.3mf")), "a path not made yet");
        assert_eq!(at("in/new.3mf"), Ok(real.join("parts/new.3mf")));
        assert_eq!(at(".m3d/chat.json"), Ok(real.join(".m3d/chat.json")), "the project's records are its callers' rule");
        for name in ["", "..", "../folder/parts/arm.stl", "parts/../parts/arm.stl", "./parts/arm.stl", "/etc/passwd", "../other/a.stl", "print/../../x.3mf", "./a.stl"] {
            assert_eq!(at(name), Err("not a name"), "{name:?}");
        }
        for link in ["out", "out/secret.stl", "out/new.3mf", "away.stl"] {
            assert_eq!(at(link), Err("leads outside"), "{link}");
        }
        assert_eq!(at("dangling"), Err("unreadable"));
        assert_eq!(at("parts/arm.stl/x"), Err("unreadable"), "a file is no folder");
        assert_eq!(kind(inside(&around.path().join("missing"), "a.stl")), Err("unreadable"));
    }
}
