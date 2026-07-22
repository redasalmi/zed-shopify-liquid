use std::{env, fs};
use zed::settings::LspSettings;
use zed_extension_api::{self as zed, serde_json, Result};

struct LiquidExtension {
    did_find_server: bool,
}

// Use the same language server package as Shopify's VS Code extension. Running
// the full CLI adds an unrelated bootstrap layer and couples the extension to
// the CLI's stricter Node.js version requirement.
const PACKAGE_NAME: &str = "@shopify/theme-language-server-node";
const PACKAGE_VERSION: &str = "2.22.0";
const SERVER_PATH: &str = "node_modules/@shopify/theme-language-server-node/dist/index.js";
const SERVER_WRAPPER_PATH: &str = "run-liquid-language-server.cjs";
const SERVER_WRAPPER: &str = r#"const { startServer } = require('./node_modules/@shopify/theme-language-server-node/dist/index.js');

// Match Shopify's VS Code host: report unexpected failures without allowing a
// single malformed document or provider request to terminate the LSP process.
process.on('uncaughtException', (error) => console.error(error));
process.on('unhandledRejection', (error) => console.error(error));

startServer();
"#;

impl LiquidExtension {
    fn server_exists(&self) -> bool {
        fs::metadata(SERVER_PATH).is_ok_and(|stat| stat.is_file())
    }

    fn server_script_path(&mut self, language_server_id: &zed::LanguageServerId) -> Result<String> {
        if !(self.did_find_server && self.server_exists()) {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::CheckingForUpdate,
            );

            let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;
            if !self.server_exists() || installed_version.as_deref() != Some(PACKAGE_VERSION) {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::Downloading,
                );

                if let Err(error) = zed::npm_install_package(PACKAGE_NAME, PACKAGE_VERSION) {
                    // An already installed server is more useful than disabling
                    // Liquid support because an update failed while offline.
                    if !self.server_exists() {
                        return Err(error);
                    }
                }
            }

            if !self.server_exists() {
                return Err(format!(
                    "installed package '{PACKAGE_NAME}' did not contain expected path '{SERVER_PATH}'",
                ));
            }
            self.did_find_server = true;
        }

        fs::write(SERVER_WRAPPER_PATH, SERVER_WRAPPER)
            .map_err(|error| format!("failed to write Liquid language server wrapper: {error}"))?;

        env::current_dir()
            .map(|path| {
                path.join(SERVER_WRAPPER_PATH)
                    .to_string_lossy()
                    .into_owned()
            })
            .map_err(|error| {
                format!("failed to locate the Liquid extension work directory: {error}")
            })
    }
}

fn workspace_configuration(settings: Option<serde_json::Value>) -> serde_json::Value {
    settings.unwrap_or_else(|| serde_json::json!({}))
}

impl zed::Extension for LiquidExtension {
    fn new() -> Self {
        Self {
            did_find_server: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.server_script_path(language_server_id)?;
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_path],
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

    const LANGUAGE_CONFIG: &str = include_str!("../languages/liquid/config.toml");

    #[test]
    fn wrapper_starts_the_official_language_server_directly() {
        assert!(SERVER_WRAPPER.contains("@shopify/theme-language-server-node/dist/index.js"));
        assert!(SERVER_WRAPPER.contains("startServer();"));
    }

    #[test]
    fn wrapper_keeps_protocol_output_clean_and_reports_async_failures() {
        assert!(!SERVER_WRAPPER.contains("console.log"));
        assert!(SERVER_WRAPPER.contains("uncaughtException"));
        assert!(SERVER_WRAPPER.contains("unhandledRejection"));
        assert!(SERVER_WRAPPER.contains("console.error"));

        let handler = SERVER_WRAPPER.find("uncaughtException").unwrap();
        let start = SERVER_WRAPPER.find("startServer();").unwrap();
        assert!(
            handler < start,
            "recovery handlers must be active before startup"
        );
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
