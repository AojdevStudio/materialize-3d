//! The in-app agent's system prompt, generated from the kind registry.
//!
//! The prompt is the same for every turn of an app whose kinds do not change,
//! so providers can cache it as the request's prefix. Only the kinds the app
//! can build now appear in its catalog ([`kind::catalog`]): `part`, with its
//! script contract, only when the CAD runtime verified.

use crate::fabrication::kind::{self, KindDriver};

const RULES: &str = "\
You design printable objects for a Bambu Lab P2S (0.4 mm nozzle).
Use the person's measurements. If a fit-critical dimension is missing or ambiguous, ask before building.
You cannot approve, export, or record a print. Never say a design is approved or printed.";

const AFTER_BUILD: &str = "\
Call describe_kind before you build a kind marked [describe].

After build or revise:
- The new revision opens in the app for the person, so do not call show for it.
- The result carries images of the build, one per name in views. Compare them with the request. If the shape is wrong, fix it and build again before you report.
- Report the revision number and the check result: verified or failed, checks passed of total, any failed checks, warnings, and the measured requirements. If reused is true, say the identical design already existed.
- A failed build names its stage and failure_reason. Fix what they name and build again with its lineage_id, so the fix is that design's next revision, or explain what is wrong.
- To change a design, call revise with its revision_id and only the fields that change.
- Tell the person every new revision waits for their approval in the app.";

/// The system prompt for an app that can build `kinds`.
pub fn system_prompt(kinds: &[&'static dyn KindDriver]) -> String {
    format!("{RULES}\nKinds:\n{}\n{AFTER_BUILD}", kind::catalog(kinds))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fabrication::kind::{available, find, KernelContext, KINDS};
    use crate::fabrication::printer::P2S_04;

    fn part() -> &'static dyn KindDriver {
        find("part").expect("part is registered")
    }

    /// Without a runtime only signs are offered, so the prompt names no part
    /// and carries no script contract; with `part` available it carries both.
    #[test]
    fn the_part_line_and_its_contract_appear_only_when_part_is_available() {
        let signs_only = system_prompt(&available(&KernelContext::without_runtime(P2S_04)));
        let with_part = system_prompt(KINDS);
        let contract_line = part().prompt_guide().lines().next().expect("contract");

        assert!(!signs_only.contains("- part"), "{signs_only}");
        assert!(!signs_only.contains(contract_line), "{signs_only}");
        assert!(with_part.contains("- part: any solid, written as build123d\n"), "{with_part}");
        assert!(with_part.contains(&format!("  {contract_line}\n")), "the contract sits under the part line: {with_part}");
        for prompt in [&signs_only, &with_part] {
            assert!(
                prompt.contains(&format!("- sign [describe]: {}\n", find("sign").expect("sign").summary())),
                "signs keep their [describe] line: {prompt}"
            );
        }
    }

    /// The catalog is generated from the kinds it is given, in their order.
    #[test]
    fn the_catalog_lists_exactly_the_given_kinds() {
        let catalog = kind::catalog(KINDS);
        let lines: Vec<&str> = catalog.lines().filter(|line| line.starts_with("- ")).collect();
        assert_eq!(lines.len(), KINDS.len(), "{catalog}");
        for (line, kind) in lines.iter().zip(KINDS) {
            assert!(line.starts_with(&format!("- {}", kind.id())), "{line}");
        }
        assert_eq!(kind::catalog(&[]), "");
    }

    #[test]
    fn the_prompt_asks_before_building_and_never_claims_approval() {
        let prompt = system_prompt(KINDS);
        assert!(prompt.contains("If a fit-critical dimension is missing or ambiguous, ask before building."));
        assert!(prompt.contains("You cannot approve, export, or record a print."));
        for kind in KINDS {
            assert!(!kind.guide().trim().is_empty(), "{} has a describe_kind guide", kind.id());
        }
    }
}
