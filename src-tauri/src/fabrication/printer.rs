//! The printer a package targets: bed, filament slots, and the verified
//! Bambu Studio project settings. The package writer, sign validation, and
//! slice verification read these values from a profile instead of keeping
//! their own copies.

/// Micrometers. Every printable model sits on this grid.
pub type Um = i64;

pub const UM_PER_MM: Um = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrinterProfile {
    /// Build volume (x, y, z). The plate spans `[0, bed[0]] x [0, bed[1]]`.
    pub bed: [Um; 3],
    /// Filament slots the project template configures.
    pub slots: u8,
    /// Bambu Studio project settings JSON the package embeds and the slice uses.
    pub template: &'static str,
}

impl PrinterProfile {
    /// Plate center, x and y.
    pub const fn bed_center(&self) -> [Um; 2] {
        [self.bed[0] / 2, self.bed[1] / 2]
    }

    /// Longest edge that fits on the plate in either direction.
    pub const fn max_edge(&self) -> Um {
        if self.bed[0] < self.bed[1] {
            self.bed[0]
        } else {
            self.bed[1]
        }
    }
}

/// Bambu Lab P2S, 0.4 mm nozzle, 0.20 mm Standard, three Bambu PLA Basic slots,
/// as Bambu Studio 02.08.02.61 exports it (see resources/bambu/README.md). The
/// bed and slot count are the template's `printable_area`, `printable_height`,
/// and `filament_settings_id`; a test holds them equal.
pub const P2S_04: PrinterProfile = PrinterProfile {
    bed: [256 * UM_PER_MM, 256 * UM_PER_MM, 256 * UM_PER_MM],
    slots: 3,
    template: include_str!("../../resources/bambu/p2s-0.4-pla-basic-x3.project_settings.json"),
};

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn the_p2s_profile_matches_its_project_template() {
        let template: Value = serde_json::from_str(P2S_04.template).expect("template parses");
        let area: Vec<&str> = template["printable_area"]
            .as_array()
            .expect("printable_area")
            .iter()
            .map(|corner| corner.as_str().expect("corner"))
            .collect();
        let [x, y] = [P2S_04.bed[0], P2S_04.bed[1]].map(|v| v / UM_PER_MM);
        assert_eq!(area, [format!("0x0"), format!("{x}x0"), format!("{x}x{y}"), format!("0x{y}")]);
        assert_eq!(template["printable_height"], (P2S_04.bed[2] / UM_PER_MM).to_string());
        let filaments = template["filament_settings_id"].as_array().expect("filaments").len();
        assert_eq!(filaments, usize::from(P2S_04.slots));
        assert_eq!(P2S_04.bed_center(), [128_000, 128_000]);
    }
}
