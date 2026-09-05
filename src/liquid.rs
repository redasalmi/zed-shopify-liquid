use std::{env, fs};
use zed::settings::LspSettings;
use zed_extension_api::{self as zed, serde_json, Result};

struct LiquidExtension {
    did_find_server: bool,
    did_find_typescript: bool,
    did_find_support_packages: bool,
}

// Use the same language server package as Shopify's VS Code extension. Running
// the full CLI adds an unrelated bootstrap layer and couples the extension to
// the CLI's stricter Node.js version requirement.
const PACKAGE_NAME: &str = "@shopify/theme-language-server-node";
const PACKAGE_VERSION: &str = "2.22.1";
const SERVER_PATH: &str = "node_modules/@shopify/theme-language-server-node/dist/index.js";
const SERVER_WRAPPER_PATH: &str = "run-liquid-language-server.cjs";
const EMBEDDED_SERVER_ID: &str = "liquid-embedded-javascript";
const EMBEDDED_SERVER_PATH: &str = "run-liquid-embedded-javascript-server.cjs";
const EMBEDDED_NODE_HEAP_ARG: &str = "--max-old-space-size=128";
const TYPESCRIPT_PACKAGE_NAME: &str = "typescript";
const TYPESCRIPT_SERVER_PATH: &str = "node_modules/typescript/lib/typescript.js";
// TypeScript 7 currently exposes only its native CLI from CommonJS; the
// embedded language server requires the stable JavaScript language-service API.
const TYPESCRIPT_PACKAGE_VERSION: &str = "5.9.3";
// These packages are imported directly by the supplemental server. They are
// also transitive dependencies of Shopify's server today, but relying on that
// implementation detail would make an upstream update fail at runtime.
const LIQUID_HTML_PARSER_VERSION: &str = "2.10.0";
const THEME_CHECK_DOCS_UPDATER_VERSION: &str = "3.28.1";
const THEME_LANGUAGE_SERVER_COMMON_VERSION: &str = "2.22.1";
const VSCODE_CSS_LANGUAGE_SERVICE_VERSION: &str = "6.3.2";
const VSCODE_LANGUAGE_SERVER_VERSION: &str = "8.1.0";
const VSCODE_LANGUAGE_SERVER_TEXTDOCUMENT_VERSION: &str = "1.0.12";
const SUPPORT_PACKAGES: &[(&str, &str, &str)] = &[
    (
        "@shopify/liquid-html-parser",
        LIQUID_HTML_PARSER_VERSION,
        "node_modules/@shopify/liquid-html-parser/dist/index.js",
    ),
    (
        "@shopify/theme-check-docs-updater",
        THEME_CHECK_DOCS_UPDATER_VERSION,
        "node_modules/@shopify/theme-check-docs-updater/dist/index.js",
    ),
    (
        "@shopify/theme-language-server-common",
        THEME_LANGUAGE_SERVER_COMMON_VERSION,
        "node_modules/@shopify/theme-language-server-common/dist/utils/liquidDoc.js",
    ),
    (
        "vscode-css-languageservice",
        VSCODE_CSS_LANGUAGE_SERVICE_VERSION,
        "node_modules/vscode-css-languageservice/lib/umd/cssLanguageService.js",
    ),
    (
        "vscode-languageserver",
        VSCODE_LANGUAGE_SERVER_VERSION,
        "node_modules/vscode-languageserver/node.js",
    ),
    (
        "vscode-languageserver-textdocument",
        VSCODE_LANGUAGE_SERVER_TEXTDOCUMENT_VERSION,
        "node_modules/vscode-languageserver-textdocument/lib/umd/main.js",
    ),
];
const EMBEDDED_SERVER: &str = include_str!("../language-server/embedded-javascript-server.cjs");
const EMBEDDED_SUPPORT_FILES: &[(&str, &str)] = &[
    (
        "liquid-doc-tools.cjs",
        include_str!("../language-server/liquid-doc-tools.cjs"),
    ),
    (
        "embedded-language.cjs",
        include_str!("../language-server/embedded-language.cjs"),
    ),
    (
        "liquid-document-analysis.cjs",
        include_str!("../language-server/liquid-document-analysis.cjs"),
    ),
    (
        "theme-roots.cjs",
        include_str!("../language-server/theme-roots.cjs"),
    ),
    (
        "schema-settings.cjs",
        include_str!("../language-server/schema-settings.cjs"),
    ),
];
const SERVER_WRAPPER: &str = r#"const { startServer } = require('./node_modules/@shopify/theme-language-server-node/dist/index.js');

// Provider-level failures are handled by the LSP framework. A truly uncaught
// exception can leave shared server state inconsistent, so log it to stderr and
// exit for Zed to report rather than continuing in an unknown state.
function terminateAfterUnexpectedFailure(error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  setImmediate(() => process.exit(1));
}

// An unhandled rejection is isolated to one asynchronous operation more often
// than an uncaught exception. Keep the long-lived LSP process available for
// later requests; Zed does not currently restart a server after it exits.
function reportUnhandledRejection(reason) {
  console.error(reason instanceof Error ? reason.stack || reason.message : String(reason));
}

process.once('uncaughtException', terminateAfterUnexpectedFailure);
process.on('unhandledRejection', reportUnhandledRejection);

startServer();
"#;

impl LiquidExtension {
    fn server_exists(&self) -> bool {
        fs::metadata(SERVER_PATH).is_ok_and(|stat| stat.is_file())
    }

    fn typescript_exists(&self) -> bool {
        fs::metadata(TYPESCRIPT_SERVER_PATH).is_ok_and(|stat| stat.is_file())
    }

    fn report_installation_result<T>(
        language_server_id: &zed::LanguageServerId,
        result: Result<T>,
    ) -> Result<T> {
        match result {
            Ok(value) => {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::None,
                );
                Ok(value)
            }
            Err(error) => {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::Failed(error.clone()),
                );
                Err(error)
            }
        }
    }

    fn ensure_npm_package<F>(
        &self,
        language_server_id: &zed::LanguageServerId,
        package_name: &str,
        package_version: &str,
        is_usable: F,
    ) -> Result<()>
    where
        F: Fn() -> bool,
    {
        let installed_version = zed::npm_package_installed_version(package_name)?;
        if installed_version.as_deref() != Some(package_version) || !is_usable() {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            if let Err(error) = zed::npm_install_package(package_name, package_version) {
                // Keep an older usable package when an update fails while
                // offline instead of disabling Liquid support.
                if !is_usable() {
                    return Err(error);
                }
            }
        }

        if !is_usable() {
            return Err(format!(
                "installed package '{package_name}' is unavailable after installation",
            ));
        }
        Ok(())
    }

    fn server_script_path(&mut self, language_server_id: &zed::LanguageServerId) -> Result<String> {
        let result = (|| {
            if !(self.did_find_server && self.server_exists()) {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::CheckingForUpdate,
                );
                self.ensure_npm_package(language_server_id, PACKAGE_NAME, PACKAGE_VERSION, || {
                    self.server_exists()
                })?;
                if !self.server_exists() {
                    return Err(format!(
                        "installed package '{PACKAGE_NAME}' did not contain expected path '{SERVER_PATH}'",
                    ));
                }
                self.did_find_server = true;
            }

            fs::write(SERVER_WRAPPER_PATH, SERVER_WRAPPER).map_err(|error| {
                format!("failed to write Liquid language server wrapper: {error}")
            })?;

            env::current_dir()
                .map(|path| {
                    path.join(SERVER_WRAPPER_PATH)
                        .to_string_lossy()
                        .into_owned()
                })
                .map_err(|error| {
                    format!("failed to locate the Liquid extension work directory: {error}")
                })
        })();

        Self::report_installation_result(language_server_id, result)
    }

    fn embedded_server_script_path(
        &mut self,
        language_server_id: &zed::LanguageServerId,
    ) -> Result<String> {
        let result = (|| {
            self.server_script_path(language_server_id)?;

            let support_packages_exist = || {
                SUPPORT_PACKAGES.iter().all(|(_, _, entry_path)| {
                    fs::metadata(entry_path).is_ok_and(|stat| stat.is_file())
                })
            };
            if !(self.did_find_support_packages && support_packages_exist()) {
                for (package_name, package_version, entry_path) in SUPPORT_PACKAGES {
                    self.ensure_npm_package(
                        language_server_id,
                        package_name,
                        package_version,
                        || fs::metadata(entry_path).is_ok_and(|stat| stat.is_file()),
                    )?;
                }
                self.did_find_support_packages = true;
            }

            if !(self.did_find_typescript && self.typescript_exists()) {
                self.ensure_npm_package(
                    language_server_id,
                    TYPESCRIPT_PACKAGE_NAME,
                    TYPESCRIPT_PACKAGE_VERSION,
                    || self.typescript_exists(),
                )?;
                if !self.typescript_exists() {
                    return Err(format!(
                        "installed package '{TYPESCRIPT_PACKAGE_NAME}' did not contain expected path '{TYPESCRIPT_SERVER_PATH}'",
                    ));
                }
                self.did_find_typescript = true;
            }

            let embedded_server = format!(
                "process.env.LIQUID_EXTENSION_VERSION ||= {:?};\n{}",
                env!("CARGO_PKG_VERSION"),
                EMBEDDED_SERVER,
            );
            fs::write(EMBEDDED_SERVER_PATH, embedded_server).map_err(|error| {
                format!("failed to write embedded JavaScript language server: {error}")
            })?;
            for (path, source) in EMBEDDED_SUPPORT_FILES {
                fs::write(path, source).map_err(|error| {
                    format!("failed to write embedded support module '{path}': {error}")
                })?;
            }

            env::current_dir()
                .map(|path| {
                    path.join(EMBEDDED_SERVER_PATH)
                        .to_string_lossy()
                        .into_owned()
                })
                .map_err(|error| {
                    format!("failed to locate the Liquid extension work directory: {error}")
                })
        })();

        Self::report_installation_result(language_server_id, result)
    }
}

fn workspace_configuration(settings: Option<serde_json::Value>) -> serde_json::Value {
    settings.unwrap_or_else(|| serde_json::json!({}))
}

impl zed::Extension for LiquidExtension {
    fn new() -> Self {
        Self {
            did_find_server: false,
            did_find_typescript: false,
            did_find_support_packages: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let is_embedded_server = language_server_id.as_ref() == EMBEDDED_SERVER_ID;
        let server_path = if is_embedded_server {
            self.embedded_server_script_path(language_server_id)?
        } else {
            self.server_script_path(language_server_id)?
        };
        let args = if is_embedded_server {
            // Bundled JavaScript blocks are intentionally small. A conservative
            // heap cap prevents V8 from retaining hundreds of megabytes after
            // repeated completion requests while leaving ample room for the
            // TypeScript standard libraries and incremental program.
            vec![EMBEDDED_NODE_HEAP_ARG.into(), server_path]
        } else {
            vec![server_path]
        };

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args,
            env: Default::default(),
        })
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let settings = LspSettings::for_worktree("liquid", worktree)
            .ok()
            .and_then(|lsp_settings| lsp_settings.settings.clone());

        // The server requests keys such as `themeCheck.checkOnChange`. Keep
        // them at the configuration root instead of nesting them under
        // `liquid`, which caused Zed to answer those requests with no value.
        Ok(Some(workspace_configuration(settings)))
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(LspSettings::for_worktree("liquid", worktree)
            .ok()
            .and_then(|lsp_settings| lsp_settings.initialization_options.clone()))
    }
}

zed::register_extension!(LiquidExtension);

#[cfg(test)]
mod tests {
    use super::*;

    const EXTENSION_MANIFEST: &str = include_str!("../extension.toml");
    const EXTENSION_SOURCE: &str = include_str!("liquid.rs");
    const LANGUAGE_CONFIG: &str = include_str!("../languages/liquid/config.toml");
    const TEST_PACKAGE: &str = include_str!("../package.json");
    #[test]
    fn wrapper_starts_the_official_language_server_directly() {
        assert!(SERVER_WRAPPER.contains("@shopify/theme-language-server-node/dist/index.js"));
        assert!(SERVER_WRAPPER.contains("startServer();"));
    }

    #[test]
    fn wrapper_keeps_protocol_output_clean_and_recovers_unhandled_rejections() {
        assert!(!SERVER_WRAPPER.contains("console.log"));
        assert!(SERVER_WRAPPER.contains("uncaughtException"));
        assert!(SERVER_WRAPPER.contains("unhandledRejection"));
        assert!(SERVER_WRAPPER.contains("console.error"));
        assert!(SERVER_WRAPPER.contains("process.exit(1)"));
        assert!(SERVER_WRAPPER.contains("reportUnhandledRejection"));
        assert!(!SERVER_WRAPPER.contains("process.once('unhandledRejection'"));

        let handler = SERVER_WRAPPER.find("uncaughtException").unwrap();
        let start = SERVER_WRAPPER.find("startServer();").unwrap();
        assert!(
            handler < start,
            "recovery handlers must be active before startup"
        );
    }

    #[test]
    fn installation_status_is_cleared_or_failed_explicitly() {
        assert!(EXTENSION_SOURCE.contains("LanguageServerInstallationStatus::None"));
        assert!(EXTENSION_SOURCE.contains("LanguageServerInstallationStatus::Failed"));
    }

    #[test]
    fn diagnostic_configuration_is_not_hidden_under_an_extension_key() {
        let settings = serde_json::json!({
            "themeCheck": {
                "checkOnOpen": true,
                "checkOnChange": true,
                "checkOnSave": true
            }
        });

        let configuration = workspace_configuration(Some(settings));
        assert_eq!(configuration["themeCheck"]["checkOnChange"], true);
        assert!(configuration.get("liquid").is_none());
    }

    #[test]
    fn diagnostic_defaults_remain_owned_by_the_language_server() {
        assert_eq!(workspace_configuration(None), serde_json::json!({}));
    }

    #[test]
    fn package_entry_matches_the_wrapper_dependency() {
        assert!(SERVER_PATH.ends_with("/dist/index.js"));
        assert!(SERVER_WRAPPER.contains(SERVER_PATH));
    }

    #[test]
    fn protocol_test_dependencies_match_runtime_packages() {
        let package: serde_json::Value = serde_json::from_str(TEST_PACKAGE).unwrap();
        assert_eq!(package["devDependencies"][PACKAGE_NAME], PACKAGE_VERSION);
        assert_eq!(
            package["devDependencies"][TYPESCRIPT_PACKAGE_NAME],
            TYPESCRIPT_PACKAGE_VERSION
        );
        for (package_name, package_version, entry_path) in SUPPORT_PACKAGES {
            assert_eq!(
                package["devDependencies"][*package_name], *package_version,
                "support package pin must match the embedded server runtime",
            );
            assert!(entry_path.starts_with("node_modules/"));
            assert!(entry_path.ends_with(".js"));
        }
    }

    #[test]
    fn query_test_grammar_matches_the_extension_pin() {
        let package: serde_json::Value = serde_json::from_str(TEST_PACKAGE).unwrap();
        let grammar_package = package["devDependencies"]["tree-sitter-liquid"]
            .as_str()
            .unwrap();
        let grammar_commit = EXTENSION_MANIFEST
            .lines()
            .find_map(|line| line.strip_prefix("commit = \"")?.strip_suffix('"'))
            .unwrap();
        assert!(grammar_package.contains(grammar_commit));
        assert_eq!(package["allowScripts"][grammar_package], false);
    }

    #[test]
    fn embedded_server_scopes_semantic_features_to_supported_regions() {
        let embedded_language = EMBEDDED_SUPPORT_FILES
            .iter()
            .find_map(|(path, source)| (*path == "embedded-language.cjs").then_some(*source))
            .unwrap();
        let liquid_analysis = EMBEDDED_SUPPORT_FILES
            .iter()
            .find_map(|(path, source)| (*path == "liquid-document-analysis.cjs").then_some(*source))
            .unwrap();
        let theme_roots = EMBEDDED_SUPPORT_FILES
            .iter()
            .find_map(|(path, source)| (*path == "theme-roots.cjs").then_some(*source))
            .unwrap();
        let liquid_doc_tools = EMBEDDED_SUPPORT_FILES
            .iter()
            .find_map(|(path, source)| (*path == "liquid-doc-tools.cjs").then_some(*source))
            .unwrap();

        assert!(EMBEDDED_SERVER.contains("require('./embedded-language.cjs')"));
        assert!(EMBEDDED_SERVER.contains("require('./liquid-document-analysis.cjs')"));
        assert!(EMBEDDED_SERVER.contains("require('./theme-roots.cjs')"));
        assert!(EMBEDDED_SERVER.contains("require('./liquid-doc-tools.cjs')"));
        assert!(liquid_doc_tools.contains("theme-language-server-common/dist/utils/liquidDoc"));
        assert!(liquid_doc_tools.contains("SUPPORTED_LIQUID_DOC_TAG_HANDLES"));
        assert!(embedded_language.contains("embeddedLanguage(source, 'javascript'"));
        assert!(embedded_language.contains("embeddedLanguage(source, 'stylesheet'"));
        assert!(embedded_language.contains("slice(0, 1)"));
        assert!(embedded_language.contains("(function(){"));
        assert!(liquid_analysis.contains("function rawTagNodes(source)"));
        assert!(theme_roots.contains("configuredThemeRootForFile"));
        assert!(EMBEDDED_SERVER.contains("EMBEDDED_THEME_DIRECTORIES"));
        assert!(EMBEDDED_SERVER.contains("getCompletionsAtPosition"));
        assert!(EMBEDDED_SERVER.contains("getCompletionEntryDetails"));
        assert!(EMBEDDED_SERVER.contains("getSemanticDiagnostics"));
        assert!(EMBEDDED_SERVER.contains("containsOffset(state.embedded.ranges"));
        assert!(EMBEDDED_SERVER.contains("settingsCompletions"));
        assert!(EMBEDDED_SERVER.contains("schema.blocks.flatMap"));
        assert!(EMBEDDED_SERVER.contains("liquidDocTypeCompletions"));
        assert!(EMBEDDED_SERVER.contains("liquidDocTagCompletions"));
        assert!(EMBEDDED_SERVER.contains("@shopify/theme-check-docs-updater"));
        assert!(EMBEDDED_SERVER.contains("liquidDocTools()"));
        assert!(EMBEDDED_SERVER.contains("CompletionItemKind.EnumMember"));
        assert!(EMBEDDED_SERVER.contains("`${name}[]`"));
        assert!(EMBEDDED_SERVER.contains("textEdit"));
        assert!(EMBEDDED_SERVER.contains("definitionForReference"));
        assert!(EMBEDDED_SERVER.contains("javascriptDefinitions"));
        assert!(EMBEDDED_SERVER.contains("stylesheetDefinition"));
        assert!(EMBEDDED_SERVER.contains("embeddedRangeFormatting"));
        assert!(EMBEDDED_SERVER.contains("vscode-css-languageservice"));
        assert!(liquid_analysis.contains("toTolerantLiquidHtmlAST"));
        assert!(EMBEDDED_SERVER.contains("pathToFileURL(candidate)"));
    }

    #[test]
    fn official_server_is_attached_to_theme_json() {
        assert!(EXTENSION_MANIFEST.contains("languages = [\"Liquid\", \"JSON\"]"));
        assert!(EXTENSION_MANIFEST.contains("Liquid = \"liquid\""));
        assert!(EXTENSION_MANIFEST.contains("JSON = \"json\""));
    }

    #[test]
    fn embedded_server_uses_stable_typescript_language_service() {
        assert_eq!(TYPESCRIPT_PACKAGE_VERSION, "5.9.3");
        assert!(TYPESCRIPT_SERVER_PATH.ends_with("/lib/typescript.js"));
        assert!(EMBEDDED_SERVER.contains("ts.createLanguageService"));
        assert!(EMBEDDED_SERVER.contains("One incremental service is shared"));
        assert!(EMBEDDED_SERVER.contains("process.env.LIQUID_EXTENSION_VERSION"));
        let manifest_version = EXTENSION_MANIFEST
            .lines()
            .find_map(|line| line.strip_prefix("version = \"")?.strip_suffix('"'))
            .unwrap();
        assert_eq!(env!("CARGO_PKG_VERSION"), manifest_version);
        assert_eq!(EMBEDDED_NODE_HEAP_ARG, "--max-old-space-size=128");
    }

    #[test]
    fn property_access_triggers_unfiltered_completions() {
        let query_characters = LANGUAGE_CONFIG
            .lines()
            .find(|line| line.starts_with("completion_query_characters"))
            .expect("Liquid must configure completion query characters");

        assert!(
            !query_characters.contains("\".\""),
            "including '.' makes Zed filter product property results against 'product.'"
        );
    }
}
