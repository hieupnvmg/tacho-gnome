# Tacho for GNOME
#
#   make            build both zips in build/
#                   build/github/…zip  updates itself from GitHub releases
#                   build/ego/…zip     for extensions.gnome.org (no updater)
#   make install    build, then install the GitHub build for this user
#   make test       run the parser tests (needs Node 18+)
#   make smoke      run the Gio readers under plain GJS against fixtures
#   make lint       ESLint (fetched with npx)
#   make pot        refresh po/ from the sources
#   make clean
#
# Releases: ./release.sh <version> "notes" [--pre]

UUID      := tacho@hieupnvmg.github.io
BUILD     := build
ZIPNAME   := $(UUID).shell-extension.zip
GITHUB_ZIP := $(BUILD)/github/$(ZIPNAME)
EGO_ZIP   := $(BUILD)/ego/$(ZIPNAME)

SOURCES   := extension.js prefs.js metadata.json stylesheet.css
LIBS      := $(filter-out lib/updater.js,$(wildcard lib/*.js))
ICONS     := $(wildcard icons/*.svg)
SCHEMA    := schemas/org.gnome.shell.extensions.tacho.gschema.xml
LANGS     := $(basename $(notdir $(wildcard po/*.po)))
SHA256    := $(shell command -v sha256sum >/dev/null 2>&1 && echo sha256sum || echo shasum -a 256)
DEPS      := $(SOURCES) $(LIBS) lib/updater.js $(ICONS) $(SCHEMA) $(wildcard po/*.po) LICENSE

.PHONY: all zip github ego install uninstall test smoke lint pot clean check

all: github ego
zip: all
github: $(GITHUB_ZIP)
ego: $(EGO_ZIP)

# $(call stage,channel): copy the extension into build/<channel>/stage.
define stage
	rm -rf $(BUILD)/$(1)
	mkdir -p $(BUILD)/$(1)/stage/lib $(BUILD)/$(1)/stage/icons $(BUILD)/$(1)/stage/schemas
	cp $(SOURCES) LICENSE $(BUILD)/$(1)/stage/
	cp $(LIBS) $(BUILD)/$(1)/stage/lib/
	cp $(ICONS) $(BUILD)/$(1)/stage/icons/
	cp $(SCHEMA) $(BUILD)/$(1)/stage/schemas/
	glib-compile-schemas --strict $(BUILD)/$(1)/stage/schemas
	for lang in $(LANGS); do \
		mkdir -p $(BUILD)/$(1)/stage/locale/$$lang/LC_MESSAGES; \
		msgfmt --check -o $(BUILD)/$(1)/stage/locale/$$lang/LC_MESSAGES/$(UUID).mo po/$$lang.po || exit 1; \
	done
endef

$(GITHUB_ZIP): $(DEPS)
	$(call stage,github)
	cp lib/updater.js $(BUILD)/github/stage/lib/
	python3 -c 'import json,sys; p=sys.argv[1]; m=json.load(open(p)); m["update-channel"]="github"; json.dump(m,open(p,"w"),indent=2,ensure_ascii=False); open(p,"a").write("\n")' $(BUILD)/github/stage/metadata.json
	cd $(BUILD)/github/stage && zip -qr ../$(ZIPNAME) .
	cd $(BUILD)/github && $(SHA256) $(ZIPNAME) > $(ZIPNAME).sha256
	@echo "Built $(GITHUB_ZIP)"

$(EGO_ZIP): $(DEPS)
	$(call stage,ego)
	cd $(BUILD)/ego/stage && zip -qr ../$(ZIPNAME) .
	@echo "Built $(EGO_ZIP)"

install: $(GITHUB_ZIP)
	gnome-extensions install --force $(GITHUB_ZIP)
	@echo "Installed. On Wayland, log out and back in; on X11, press Alt+F2, type r, Enter."
	@echo "Then: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

check:
	glib-compile-schemas --strict --dry-run schemas
	for f in extension.js prefs.js lib/*.js; do node --check $$f || exit 1; done
	for lang in $(LANGS); do msgfmt --check -o /dev/null po/$$lang.po || exit 1; done

test:
	node --test test/*.test.js

smoke:
	gjs -m test/gjs-smoke.js

lint:
	npx --yes eslint@9 .

pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --add-comments=Translators \
		--package-name=tacho-gnome --msgid-bugs-address=https://github.com/hieupnvmg/tacho-gnome/issues \
		-o po/$(UUID).pot extension.js prefs.js lib/*.js
	for lang in $(LANGS); do msgmerge --quiet --update --backup=none po/$$lang.po po/$(UUID).pot; done

clean:
	rm -rf $(BUILD)
