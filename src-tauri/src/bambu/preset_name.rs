//! The parts of a Bambu preset's name. Bambu Studio names a printer preset `<printer> <nozzle> nozzle`, as in
//! `Bambu Lab P2S 0.4 nozzle`, and a filament or process preset `<name> @BBL <printer>`, sometimes with more after the
//! printer, as in `Bambu PETG Basic @BBL P2S 0.4 nozzle`.

const MAKER: &str = "Bambu Lab ";

/// The printer and its nozzle size in mm: `Bambu Lab P2S 0.4 nozzle` is `Bambu Lab P2S` and `0.4`.
pub fn printer_and_nozzle(machine: &str) -> Option<(&str, &str)> {
    machine.strip_suffix(" nozzle")?.rsplit_once(' ')
}

/// The printer and nozzle of a Bambu Lab printer preset. Bambu Studio ships printers of other makers named the same
/// way, such as `Prusa MK3S 0.4 nozzle`, and the slice step cannot use them.
pub fn bambu_lab_printer(machine: &str) -> Option<(&str, &str)> {
    printer_and_nozzle(machine).filter(|(printer, _)| printer.starts_with(MAKER))
}

/// A printer model without the maker's name: `Bambu Lab P2S` is `P2S`.
pub fn model(printer: &str) -> &str {
    printer.strip_prefix(MAKER).unwrap_or(printer)
}

/// A filament preset without the maker's name or the printer: `Bambu PETG Basic @BBL P2S` is `PETG Basic`.
pub fn filament(preset: &str) -> &str {
    let name = preset.split_once(" @").map_or(preset, |(name, _)| name);
    name.strip_prefix("Bambu ").unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_printer_preset_name_splits_into_the_printer_and_its_nozzle() {
        for (machine, parts) in [
            ("Bambu Lab P2S 0.4 nozzle", Some(("Bambu Lab P2S", "0.4"))),
            ("Bambu Lab A1 mini 0.2 nozzle", Some(("Bambu Lab A1 mini", "0.2"))),
            ("Bambu Lab X1 Carbon 0.6 nozzle", Some(("Bambu Lab X1 Carbon", "0.6"))),
            ("Bambu Lab P2S nozzle", None),
            ("Bambu Lab P2S", None),
            ("Bambu Lab P2S 0.4 nozzle - mine", None),
            ("Prusa MK3S 0.4 nozzle", None),
            ("Bambu PETG Basic @BBL P2S 0.4 nozzle", None),
            ("0.20mm Standard @BBL P2S", None),
        ] {
            assert_eq!(bambu_lab_printer(machine), parts, "{machine}");
        }
        assert_eq!(printer_and_nozzle("Prusa MK3S 0.4 nozzle"), Some(("Prusa MK3S", "0.4")));
        assert_eq!(printer_and_nozzle("Bambu Lab P2S 10.4 nozzle"), Some(("Bambu Lab P2S", "10.4")));
    }
}
