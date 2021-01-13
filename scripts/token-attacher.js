'use strict';
import {libWrapper} from './shim.js';
(async () => {
	const moduleName = "token-attacher";
	const templatePath = `/modules/${moduleName}/templates`;
	const dataModelVersion = 3;
	//CONFIG.debug.hooks = true

	class TASettings extends FormApplication {
		static init() {
		game.settings.registerMenu(moduleName, 'menu', {
			name: '',
			label: 'Token Attacher GM Menu',
			type: TASettings,
			restricted: true
		  });
		}
	
		static get defaultOptions() {
			return {
				...super.defaultOptions,
				template: `${templatePath}/tokenAttacherSettings.html`,
				height: "auto",
				title: "Token Attacher GM Menu",
				width: 600,
				classes: ["token-attacher-gm-menu","settings"],
				tabs: [ 
					{
						navSelector: '.tabs',
						contentSelector: 'form',
						initial: 'info'
					} 
				],
				submitOnClose: false
			}
		}
	
	
		constructor(object = {}, options) {
			super(object, options);
		}
	
		_getHeaderButtons() {
			return super._getHeaderButtons();
		}
	
	
		getData() {
			return  super.getData();
		}
	
		activateListeners(html) {
			let force_scene_migration=html.find(".scene-migration");

			force_scene_migration.click(()=>{TokenAttacher._migrateScene();});
			//super.activateListeners(html);
		}
	
	}

	class TokenAttacher {
		static initMacroAPI(){
			if(getProperty(getProperty(window,'tokenAttacher'),'attachElementToToken')) return;
			window.tokenAttacher = {
				...window.tokenAttacher, 
				attachElementToToken: TokenAttacher.attachElementToToken,
				attachElementsToToken: TokenAttacher.attachElementsToToken,
				detachElementFromToken: TokenAttacher.detachElementFromToken,
				detachElementsFromToken: TokenAttacher.detachElementsFromToken,
				detachAllElementsFromToken: TokenAttacher.detachAllElementsFromToken,
				getAllAttachedElementsOfToken: TokenAttacher.getAllAttachedElementsOfToken,
				getAllAttachedElementsByTypeOfToken: TokenAttacher.getAllAttachedElementsByTypeOfToken,
				getActorsWithPrototype: TokenAttacher.getActorsWithPrototype,
				getActorsWithPrototypeInCompendiums: TokenAttacher.getActorsWithPrototypeInCompendiums,
				importFromJSONDialog: TokenAttacher.importFromJSONDialog,
				importFromJSON: TokenAttacher.importFromJSON,
			};
			Hooks.callAll(`${moduleName}.macroAPILoaded`);
		}

		static initialize(){
			if(TokenAttacher.isFirstActiveGM()){
				canvas.scene.unsetFlag(moduleName,"selected");
				console.log("Token Attacher| Initialized");
			}

			window.tokenAttacher = {};
			window.tokenAttacher.selected = {};
			
			TokenAttacher.initMacroAPI();

			TokenAttacher.updatedLockedAttached();

		}

		static registerHooks(){
			Hooks.on('init', () => {
				TokenAttacher.registerSettings();
			});

			Hooks.on('ready', () => {
				TokenAttacher.initMacroAPI();
				if(TokenAttacher.isFirstActiveGM()){
					TokenAttacher.startMigration();
				}
			});
		
			Hooks.on('getSceneControlButtons', (controls) => TokenAttacher._getControlButtons(controls));
			Hooks.on('canvasReady', () => TokenAttacher.initialize());
			Hooks.once('ready', () => {
				game.socket.on(`module.${moduleName}`, (data) => TokenAttacher.listen(data));
			});
			
			Hooks.on('canvasReady', () => {
				libWrapper.register(moduleName, 'canvas.mouseInteractionManager.callbacks.dragLeftDrop', function (wrapped, ...args) {
					let result = wrapped(...args);

					TokenAttacher._RectangleSelection(...args);
					return result;
				}, 'WRAPPER');
			});

			Hooks.on("updateToken", (parent, doc, update, options, userId) => TokenAttacher.UpdateAttachedOfToken("Token", parent, doc, update, options, userId));
			Hooks.on("updateActor", (entity, data, options, userId) => TokenAttacher.updateAttachedPrototype(entity, data, options, userId));
			Hooks.on("createToken", (parent, entity, options, userId) => TokenAttacher.updateAttachedCreatedToken("Token", parent, entity, options, userId));
			Hooks.on("pasteToken", (copy, toCreate) => TokenAttacher.pasteTokens(copy, toCreate));
			Hooks.on("deleteToken", (entity, options, userId) => TokenAttacher.deleteToken(entity, options, userId));

			for (const type of ["AmbientLight", "AmbientSound", "Drawing", "MeasuredTemplate", "Note", "Tile", "Token", "Wall"]) {
				//Attached elements are not allowed to be moved by anything other then Token Attacher
				Hooks.on(`preUpdate${type}`, (parent, doc, update, options, userId) => TokenAttacher.isAllowedToMove(parent, doc, update, options, userId));
				Hooks.on(`preDelete${type}`, (parent, doc, update, options, userId) => TokenAttacher.isAllowedToMove(parent, doc, update, options, userId));
				Hooks.on(`control${type}`, (object, isControlled) => TokenAttacher.isAllowedToControl(object, isControlled));
				
				//Deleting attached elements should detach them
				Hooks.on(`delete${type}`, (parent, doc, options, userId) => TokenAttacher.DetachAfterDelete(type, parent, doc, options, userId));
				//Recreating an element from Undo History will leave them detached, so reattach them
				Hooks.on(`create${type}`, (parent, entity, options, userId) => TokenAttacher.ReattachAfterUndo(type, parent, entity, options, userId));
			}
			
		
			Hooks.on("getCompendiumDirectoryEntryContext", async (html, options) => {
				options.push( 
					{
					  name : "(TA)Export to JSON",
					  condition: game.user.isGM,
					  icon: '<i class="fas fa-file-export"></i>',
					  callback: target => {
						let pack = game.packs.get(target.data("pack"));
						if(pack.metadata.entity !== "Actor") return ui.notifications.error(game.i18n.localize("TOKENATTACHER.error.ExportAllowsOnlyActor"));
						TokenAttacher.exportCompendiumToJSON(pack);
					  }
					  
					})
			});

			//Monkeypatch PlaceablesLayer.copyObjects to hook into it
			var oldCopyObjects= PlaceablesLayer.prototype.copyObjects;

			PlaceablesLayer.prototype.copyObjects= function() {
				const result = oldCopyObjects.apply(this, arguments);
				switch(this.constructor.placeableClass.name){
					case "Token": 
						TokenAttacher.copyTokens(this, result);
					break;
				}
				return result;
			};
		}

		static registerSettings() {
			game.settings.register(moduleName,"data-model-version",{
				name: "token attacher dataModelVersion",
				hint: "token attacher dataModelVersion",
				default: 0,
				type: Number,
				scope: "world",
				config: false
			});

			TASettings.init();
		}

		static async startMigration(){
			let currentDataModelVersion = game.settings.get(moduleName, "data-model-version");
			//Migration to Model 2 is last supported on 3.2.3
			if(currentDataModelVersion < 3){
				game.settings.set(moduleName, "data-model-version", dataModelVersion + 99999);
				await TokenAttacher.migrateToDataModel_3();
			}
		}

		static async migrateToDataModel_3(){
			ui.notifications.info(game.i18n.format("TOKENATTACHER.info.MigrationInProgress", {version: dataModelVersion}));
			let scene_id_array = [];
			for (const scene of Scene.collection) {
				scene_id_array.push(scene.data._id);	
			}
			
			if(game.scenes.get(scene_id_array[0]) !== game.scenes.active){
				Hooks.once('canvasReady', () => TokenAttacher.migrateSceneHook(scene_id_array));
				await game.scenes.get(scene_id_array[0]).activate();
			}
			else{
				TokenAttacher.migrateSceneHook(scene_id_array);
			}
		}

		static async _migrateScene(){
			TokenAttacher.migrateSceneHook([game.scenes.active._id]);
		}

		static async migrateSceneHook(remaining_scenes){
			if(remaining_scenes.length > 0){
				if(game.scenes.get(remaining_scenes[0]) !== game.scenes.active){
					Hooks.once('canvasReady', () => TokenAttacher.migrateSceneHook(remaining_scenes));
					return;
				}
				else {
					for (const token of canvas.tokens.placeables) {
						const attached=token.getFlag(moduleName, 'attached') || {};
						if(Object.keys(attached).length > 0){
							await TokenAttacher._attachElementsToToken(attached, token, true);					
						}
					}
					
					ui.notifications.info(game.i18n.format("TOKENATTACHER.info.MigratedScene", {scenename: game.scenes.active.name}));
					remaining_scenes.shift();
					if(remaining_scenes.length > 0){
						Hooks.once('canvasReady', () => TokenAttacher.migrateSceneHook(remaining_scenes));
						await game.scenes.get(remaining_scenes[0]).activate();
						return;	
					}
				}
			}
			game.settings.set(moduleName, "data-model-version", dataModelVersion);
			ui.notifications.info(game.i18n.format("TOKENATTACHER.info.DataModelMergedTo", {version: dataModelVersion}));	
		}

		static updatedLockedAttached(){
			const tokens = canvas.tokens.placeables;
			for (const token of tokens) {
				const attached=token.getFlag(moduleName, "attached") || {};
				if(Object.keys(attached).length == 0) continue;
				const isLocked = token.getFlag(moduleName, "locked") || false;
				if(isLocked)
					for (const key in attached) {
						if (attached.hasOwnProperty(key) && key !== "unknown") {
							let layer = eval(key).layer ?? eval(key).collection;
							for (const elementid of attached[key]) {
								let element = layer.get(elementid);
								TokenAttacher.lockElement(key, element, false);
							}
						}
					}
			}
		}

		static lockElement(type, element, interactive){
			switch(type){
				case "Wall":{
					element.line.interactive = interactive;
					element.endpoints.interactive = interactive;
					break;
				}
				case "AmbientLight":
				case "AmbientSound":
				case "Note":
				case "MeasuredTemplate":
					element.controlIcon.interactive = interactive;
					break;
				default:
					element.interactive = interactive;
			}
		}

		static async UpdateAttachedOfToken(type, parent, doc, update, options, userId){
			if(!(	update.hasOwnProperty("x")
				||	update.hasOwnProperty("y")
				||	update.hasOwnProperty("rotation"))){
				return;
			}
			if(!TokenAttacher.isFirstActiveGM()) return;

			const token = canvas.tokens.get(update._id);
			const attached=token.getFlag(moduleName, "attached") || {};
			const tokenCenter = duplicate(token.center);
			if(Object.keys(attached).length == 0) return true;
			if(getProperty(options, moduleName)) return true;

			TokenAttacher.detectGM();

			const data = [type, mergeObject(duplicate(token.data), update)];
			if(TokenAttacher.isFirstActiveGM()) return TokenAttacher._UpdateAttachedOfBase(...data);
			else return game.socket.emit(`module.${moduleName}`, {event: `_UpdateAttachedOfBase`, eventdata: data});
		}

		static async _UpdateAttachedOfBase(type, baseData, return_data=false){
			const attached=getProperty(baseData, `flags.${moduleName}.attached`) || {};
			let attachedEntities = {};
			
			//Get Entities
			for (const key in attached) {
				const layer = canvas.getLayerByEmbeddedName(key);
				attachedEntities[key] = attached[key].map(id => layer.get(id));
			}

			let updates = {};

			//Get updates for attached elements
			for (const key in attachedEntities) {
				if (attachedEntities.hasOwnProperty(key)) {
					if(!updates.hasOwnProperty(key)) updates[key] = [];
					updates[key] = await TokenAttacher.offsetPositionOfElements(key, attachedEntities[key].map(entity => duplicate(entity.data)), type, baseData);
					if(!updates[key]) delete updates[key];
				}
			}
			if(!updates.hasOwnProperty(type)) updates[type] = [];
			let basePos = await TokenAttacher.saveBasePositon(type, baseData, true);
			updates[type].push(basePos);

			for (const key in attachedEntities) {
				if (attachedEntities.hasOwnProperty(key)) {
					for (let i = 0; i < attachedEntities[key].length; i++) {
						const element = attachedEntities[key][i];
						const elem_id = element.data._id;
						
						const elem_attached=getProperty(element, `data.flags.${moduleName}.attached`) || {};
						if(Object.keys(elem_attached).length > 0){
							const elem_update = updates[key].find(item => item._id === elem_id );
							const updatedElementData = mergeObject(duplicate(element.data), elem_update);
							const subUpdates = await TokenAttacher._UpdateAttachedOfBase(key, updatedElementData, true);
							for (const key in subUpdates) {
								if (subUpdates.hasOwnProperty(key)) {
									updates[key] = updates[key].concat(subUpdates[key]);	
									let base_updates = updates[key].filter(item => item._id === elem_id);
									if(base_updates.length > 0){
										let non_base_updates = updates[key].filter(item => item._id !== elem_id);
										let merge_update = {};
										for (let j = 0; j < base_updates.length; j++) {
											merge_update = mergeObject(merge_update, base_updates[j]);
											
										}
										non_base_updates.push(merge_update);
										updates[key] = non_base_updates;
									}
								
								}
							}
						}
					}
				}
			}
			if(return_data) return updates;
			//Fire all updates by type
			for (const key in updates) {
				await canvas.scene.updateEmbeddedEntity(key, updates[key], {[moduleName]:true});
			}
			return;
		}

		//base can be an PlacableObject but als plain data if return_data is true
		static async saveBasePositon(type, base, return_data=false, overrideData){
			let pos;
			let data = base.data ?? base;
			data = duplicate(data);
			const center = TokenAttacher.getCenter(type, data);
			if(overrideData) data = mergeObject(data, overrideData);

			pos = {base_id: data._id, xy: {x:data.x, y:data.y}, center: {x:center.x, y:center.y}, rotation:data.rotation ?? data.direction};

			if(!return_data) return base.setFlag(moduleName, "pos", pos);

			return {_id:data._id, 
				[`flags.${moduleName}.pos`]: pos};
		}

		static offsetPositionOfElements(type, data, baseType, baseData, grid){
			let baseCenter = TokenAttacher.getCenter(baseType, baseData, grid);
			let baseRotation = getProperty(baseData, "rotation") ?? getProperty(baseData, "direction");
			
			if(!Array.isArray(data)) data = [data];

			let updates = data.map(w => {
				return mergeObject(
					{_id: w._id},
					TokenAttacher.offsetPositionOfElement(type, w, baseCenter, baseRotation)
					);
			});
			if(Object.keys(updates).length == 0)  return; 
			return updates;		
		}

		static offsetPositionOfElement(type, data, baseCenter, baseRotation){
			const offset = getProperty(data, `flags.${moduleName}.offset`);
			//Line Entities
			if('c' in data){
				let c = duplicate(data.c);	
				[offset.x, offset.y] = [offset.c[0], offset.c[1]];
				[c[0],c[1]]  = TokenAttacher.moveRotatePoint({x:c[0], y:c[1], rotation:0}, offset, baseCenter, baseRotation);
				[offset.x, offset.y] = [offset.c[2], offset.c[3]];
				[c[2],c[3]]  = TokenAttacher.moveRotatePoint({x:c[2], y:c[3], rotation:0}, offset, baseCenter, baseRotation);
				return {c: c};
			}
			//Rectangle Entities
			if('width' in data || 'distance' in data || 'dim' in data || 'radius' in data){
				const [x,y,rotation] =TokenAttacher.moveRotateRectangle(data, offset, baseCenter, baseRotation);
				if(data.hasOwnProperty("direction")){
					return {x: x, y: y, direction: rotation};
			   }
				return {x: x, y: y, rotation: rotation};
			}
			//Point Entities
			const [x,y] = TokenAttacher.moveRotatePoint({x:data.x, y:data.y, rotation:0}, offset, baseCenter, baseRotation);
			return {x: x, y: y};
		}

		static computeRotatedPosition(x,y,x2,y2,rotRad){
			const dx = x2 - x,
			dy = y2 - y;
			return [x + Math.cos(rotRad)*dx - Math.sin(rotRad)*dy,
				y + Math.sin(rotRad)*dx + Math.cos(rotRad)*dy];
		}

		/**
		 * Moves a rectangle by offset values and rotates around an anchor
		 * A rectangle is defined by having a center, data._id, data.x, data.y and data.rotation or data.direction
		 */
		static moveRotateRectangle(rect, offset, anchorCenter, anchorRot){
			let x =anchorCenter.x + offset.x;
			let	y =anchorCenter.y + offset.y; 
			let newRot = (anchorRot + offset.offRot) % 360;
			if(newRot != offset.rot){
				// get vector from center to template
				const deltaRotRad = toRadians((newRot - offset.rot) % 360);
				// rotate vector around angle
				let rectCenter = {};
				rectCenter.x = anchorCenter.x + offset.centerX;
				rectCenter.y = anchorCenter.y + offset.centerY;
				[rectCenter.x,rectCenter.y] = TokenAttacher.computeRotatedPosition(anchorCenter.x, anchorCenter.y, rectCenter.x, rectCenter.y, deltaRotRad);
				x = rectCenter.x - (offset.centerX - offset.x);
				y = rectCenter.y - (offset.centerY - offset.y);
			}
			return [x, y, newRot];
		}

		/**
		 * Moves a point by offset values and rotates around an anchor
		 * A point is defined by x,y,rotation
		 */
		static moveRotatePoint(point, offset, anchorCenter, anchorRot){			
			point.x = anchorCenter.x + offset.x;
			point.y = anchorCenter.y + offset.y; 
			point.rotation=(anchorRot + offset.offRot) % 360;
			if(point.rotation != offset.rot){
				// get vector from center to template
				const deltaRotRad = toRadians((point.rotation - offset.rot) % 360);
				// rotate vector around angle
				[point.x, point.y] = TokenAttacher.computeRotatedPosition(anchorCenter.x, anchorCenter.y, point.x, point.y, deltaRotRad);
				
			}	
			return [point.x, point.y, point.rotation];
		}

		/**
		 * Only the first active GM has to do the work
		 */
		static isFirstActiveGM(){
			const firstGm = game.users.find((u) => u.isGM && u.active);
			if (firstGm && game.user === firstGm) {
				return true;
			}
			return false;
		}

		/**
		 * Warn the player if a token was moved that has attached parts
		 */
		static detectGM(){
			const firstGm = game.users.find((u) => u.isGM && u.active);
			if(!firstGm){
				return ui.notifications.error(game.i18n.localize("TOKENATTACHER.error.NoActiveGMFound"));
			}
		}
		
		/**
		 * Listen to custom socket events, so players can move elements indirectly through the gm
		 */
		static listen(data){
			switch (data.event) {
				case "AttachToToken":
					if(TokenAttacher.isFirstActiveGM())	TokenAttacher._AttachToToken(...data.eventdata);
					break;
				case "DetachFromToken":
					if(TokenAttacher.isFirstActiveGM())	TokenAttacher._DetachFromToken(...data.eventdata);
					break;
				case "attachElementsToToken":
					if(TokenAttacher.isFirstActiveGM())	TokenAttacher._attachElementsToToken(...data.eventdata);
					break;
				case "detachElementsFromToken":
					if(TokenAttacher.isFirstActiveGM())	TokenAttacher._detachElementsFromToken(...data.eventdata);
					break;
				case "ReattachAfterUndo":
					if(TokenAttacher.isFirstActiveGM())	TokenAttacher._ReattachAfterUndo(...data.eventdata);
					break;
				case "UpdateAttachedOfBase":
					if(TokenAttacher.isFirstActiveGM())	TokenAttacher._UpdateAttachedOfBase(...data.eventdata);
					break;
				default:
					console.log("Token Attacher| wtf did I just read?");
					break;
			}
		}

		/**
		 * Attach elements to token
		 */
		static async _AttachToToken(token, elements, suppressNotification=false, return_data=false){
			if(typeof token === 'string' || token instanceof String) token = canvas.tokens.get(token);
			if(!token) return ui.notifications.error(game.i18n.localize("TOKENATTACHER.error.NoTokensSelected"));
			if(!elements.hasOwnProperty("type")) return;
			
			let updates = {};
			let attached=duplicate(token.getFlag(moduleName, `attached.${elements.type}`) || []);
			
			const col = eval(elements.type).layer ?? eval(elements.type).collection;
			attached = attached.concat(elements.data.filter((item) => attached.indexOf(item) < 0))
			//Filter non existing
			attached = attached.filter((item) => col.get(item));
			let all_attached=duplicate(token.getFlag(moduleName, `attached`) || {});
			all_attached[elements.type] = attached;
			const dup = TokenAttacher.areDuplicatesInAttachChain(token, all_attached);
			if(dup !== false){
				console.log("Token Attacher | Element already in Attached Chain: ", dup);
				return ui.notifications.error(game.i18n.format("TOKENATTACHER.error.ElementAlreadyAttachedInChain"));
			}

			let token_update = await TokenAttacher.saveBasePositon(token.constructor.name, token, true);
			token_update[`flags.${moduleName}.attached.${elements.type}`] = attached;
			updates[token.constructor.name] = [token_update];

			const xy = {x:token.data.x, y:token.data.y};
			const center = {x:token.center.x, y:token.center.y};
			const rotation = token.data.rotation;

			const tokensize = TokenAttacher.getElementSize(token);
			if(!updates.hasOwnProperty(elements.type)) updates[elements.type] = [];

			for (let i = 0; i < attached.length; i++) {
				const element = col.get(attached[i]);
				updates[elements.type].push({_id:attached[i], 
					[`flags.${moduleName}.parent`]: token.data._id, 
					[`flags.${moduleName}.offset`]: TokenAttacher.getElementOffset(elements.type, element, xy, center, rotation, tokensize)});
			}
			if(return_data){
				return updates;
			}
			if(token.constructor.name !== elements.type) {
				await canvas.scene.updateEmbeddedEntity(token.constructor.name, token_update);
			}
			await canvas.scene.updateEmbeddedEntity(elements.type, updates[elements.type]);

			if(!suppressNotification) ui.notifications.info(game.i18n.localize("TOKENATTACHER.info.ObjectsAttached"));
			return; 
		}

		/**
		 * Detach previously saved selection of walls to the currently selected token
		 */
		static async _StartTokenAttach(token){
			if(!token) return ui.notifications.error(game.i18n.localize("TOKENATTACHER.error.NoTokensSelected"));
			TokenAttacher.showTokenAttacherUI(token);
		}

		/**
		 * Update Offset of all Attached elements
		 */
		static async _updateAttachedOffsets({type, element}){
			const updateFunc = async (base) =>{
				let attached=base.getFlag(moduleName, "attached") || {};
				for (const key in attached) {
					if (attached.hasOwnProperty(key) && key !== "unknown") {
						await TokenAttacher._AttachToToken(base, {type:key, data:attached[key]}, true);
						await TokenAttacher._updateAttachedOffsets({type:key, element:attached[key]});
					}
				}
			}
			const layer = canvas.getLayerByEmbeddedName(type);
			if(typeof element === 'string' || element instanceof String) element = layer.get(element);
			if(Array.isArray(element)){
				for (let i = 0; i < element.length; i++) {
					const elem = layer.get(element[i]);
					await updateFunc(elem);
				}
			}
			else await updateFunc(element);
		}

		/**
		 * Detach previously saved selection of walls to the currently selected token
		 */
		static async _DetachFromToken(token, elements, suppressNotification=false, options={}){
			if(typeof token === 'string' || token instanceof String) token = canvas.tokens.get(token);
			if(!token) return ui.notifications.error(game.i18n.localize("TOKENATTACHER.error.NoTokensSelected"));
			if(!elements || !elements.hasOwnProperty("type")){
				//Detach all
				let attached=token.getFlag(moduleName, `attached`);
				if(Object.keys(attached).length > 0){
					for (const key in attached) {
						if (attached.hasOwnProperty(key)) {
							const arr = attached[key];
							let deletes = [];
							for (let i = 0; i < arr.length; i++) {
								deletes.push({_id: arr[i], [`flags.${moduleName}.-=parent`]: null, [`flags.${moduleName}.-=offset`]: null});
							}	
							if(deletes.length > 0)	canvas.scene.updateEmbeddedEntity(key, deletes, {[moduleName]:true});						
						}
					}
				}

				token.unsetFlag(moduleName, "attached");
				if(!suppressNotification) ui.notifications.info(game.i18n.localize("TOKENATTACHER.info.ObjectsDetached"));
				return;
			}
			else{
				//Detach all passed elements
				let attached=token.getFlag(moduleName, `attached.${elements.type}`) || [];
				if(attached.length === 0) return;

				attached= attached.filter((item) => !elements.data.includes(item));
				
				token.setFlag(moduleName, `attached.${elements.type}`, attached).then(()=>{
					if(!suppressNotification) ui.notifications.info(game.i18n.localize("TOKENATTACHER.info.ObjectsDetached"));
				});
				
				const col = eval(elements.type).layer ?? eval(elements.type).collection;
				let deletes = [];
				for (let i = 0; i < elements.data.length; i++) {
					deletes.push({_id: elements.data[i], [`flags.${moduleName}.-=parent`]: null, [`flags.${moduleName}.-=offset`]: null});
				}
				if(deletes.length > 0)	canvas.scene.updateEmbeddedEntity(elements.type, deletes, {[moduleName]:true});	
			}
		}
		
		/**
		 * Hook into the toolbar and add buttons 
		 */
		static _getControlButtons(controls){
			for (let i = 0; i < controls.length; i++) {
				if(controls[i].name === "token"){
					controls[i].tools.push({
						name: "TAStartTokenAttach",
						title: game.i18n.localize("TOKENATTACHER.button.StartTokenAttach"),
						icon: "fas fa-link",
						visible: game.user.isGM,
						onClick: () => TokenAttacher._StartTokenAttach(canvas.tokens.controlled[0]),
						button: true
					  });
				}
			}
			console.log("Token Attacher | Tools added.");
		}

		static async attachElementToToken(element, target_token, suppressNotification=false){
			const type = element.constructor.name;
			const selected = [element.data._id];
			
			if(TokenAttacher.isFirstActiveGM()) return await TokenAttacher._AttachToToken(target_token, {type:type, data:selected}, suppressNotification);
			else game.socket.emit(`module.${moduleName}`, {event: `AttachToToken`, eventdata: [target_token.data._id, {type:type, data:selected}, suppressNotification]});
			
		}

		static async attachElementsToToken(element_array, target_token, suppressNotification=false){
			let selected = {}
			for (const element of element_array) {
				const type = element.constructor.name;
				if(!selected.hasOwnProperty(type)) selected[type] = [];
				selected[type].push(element.data._id);
			}
			if(TokenAttacher.isFirstActiveGM()) return await TokenAttacher._attachElementsToToken(selected, target_token, suppressNotification);
			else game.socket.emit(`module.${moduleName}`, {event: `attachElementsToToken`, eventdata: [selected, target_token.data._id, suppressNotification]});
		}

		static async _attachElementsToToken(selected, target_token, suppressNotification=false){
			if(typeof target_token === 'string' || target_token instanceof String) target_token = canvas.tokens.get(target_token);
			let updates = {};
			const type = target_token.constructor.name;
			for (const key in selected) {
				if (selected.hasOwnProperty(key)) {
					let newUpdates =await TokenAttacher._AttachToToken(target_token, {type:key, data:selected[key]}, suppressNotification, true);
					if(Object.keys(updates).length <= 0) updates = newUpdates;
					else{
						for (const key in newUpdates) {
							if (newUpdates.hasOwnProperty(key)) {
								if(!updates.hasOwnProperty(key)) updates[key] = [];
								updates[key] = updates[key].concat(newUpdates[key]);
							}
						}
					}
				}
			}
			if(updates.hasOwnProperty(type)){
				let target_token_updates = updates[type].filter(item => item._id === target_token.data._id);
				let other_updates = updates[type].filter(item => item._id !== target_token.data._id);
				let base_updates = {};
				for (let i = 0; i < target_token_updates.length; i++) {
					base_updates = mergeObject(base_updates, target_token_updates[i]);					
				}
				other_updates.push(base_updates);
				updates[type] = other_updates;
			}

			for (const key in updates) {
				if (updates.hasOwnProperty(key)) {
					await canvas.scene.updateEmbeddedEntity(key, updates[key], {[moduleName]:true});	
				}
			}
		}

		static async showTokenAttacherUI(token){
			if(!token) return;
			if(document.getElementById("tokenAttacher")) await TokenAttacher.closeTokenAttacherUI();			
			await canvas.scene.setFlag(moduleName, "attach_base", {type:token.constructor.name, element:token.data._id});
			const locked_status = token.getFlag(moduleName, "locked") || false;
			// Get the handlebars output
			const myHtml = await renderTemplate(`${templatePath}/tokenAttacherUI.html`, {["token-image"]: token.data.img, ["token-name"]: token.data.name});

			document.getElementById("hud").insertAdjacentHTML('afterend', myHtml);

			let close_button=document.getElementById("tokenAttacher").getElementsByClassName("close")[0];
			let link_tool=document.getElementById("tokenAttacher").getElementsByClassName("link")[0];
			let unlink_tool=document.getElementById("tokenAttacher").getElementsByClassName("unlink")[0];
			let unlinkAll_tool=document.getElementById("tokenAttacher").getElementsByClassName("unlink-all")[0];
			let select_tool=document.getElementById("tokenAttacher").getElementsByClassName("select")[0];
			let highlight_tool=document.getElementById("tokenAttacher").getElementsByClassName("highlight")[0];
			let copy_tool=document.getElementById("tokenAttacher").getElementsByClassName("copy")[0];
			let paste_tool=document.getElementById("tokenAttacher").getElementsByClassName("paste")[0];

			$(close_button).click(()=>{TokenAttacher.closeTokenAttacherUI();});
			$(link_tool).click(()=>{
				const current_layer = canvas.activeLayer;
				if(current_layer.controlled.length <= 0) return ui.notifications.error(game.i18n.localize(`TOKENATTACHER.error.NothingSelected`));
				if(current_layer.controlled.length == 1)
					TokenAttacher.attachElementToToken(current_layer.controlled[0], token);
				else{
					TokenAttacher.attachElementsToToken(current_layer.controlled, token);
				}
			});
			$(unlink_tool).click(()=>{
				const current_layer = canvas.activeLayer;
				if(current_layer.controlled.length <= 0) return ui.notifications.error(game.i18n.localize(`TOKENATTACHER.error.NothingSelected`));
				if(current_layer.controlled.length == 1)
					TokenAttacher.detachElementFromToken(current_layer.controlled[0], token);
				else{
					TokenAttacher.detachElementsFromToken(current_layer.controlled, token);
				}
			});
			$(unlinkAll_tool).click(()=>{
				TokenAttacher._DetachFromToken(token);
			});
			$(select_tool).click(()=>{
				select_tool.classList.toggle("active");				
				if($(document.getElementById("tokenAttacher")).find(".control-tool.select.active").length > 0){
					ui.notifications.info(game.i18n.localize(`TOKENATTACHER.info.DragSelectElements`));
				}
			});
			$(highlight_tool).click(()=>{
				TokenAttacher.highlightAttached(token, highlight_tool);
			});
			$(copy_tool).click(()=>{
				TokenAttacher.copyAttached(token);
			});
			$(paste_tool).click(()=>{
				TokenAttacher.pasteAttached(token);
			});
		}

		static lockAttached(token, button){
			const attached=token.getFlag(moduleName, "attached") || {};
			if(Object.keys(attached).length == 0) return;
			const isLocked = token.getFlag(moduleName, "locked") || false;
			let icons = button.getElementsByTagName("i");
			
			for (const key in attached) {
				if (attached.hasOwnProperty(key) && key !== "unknown") {
					let layer = eval(key).layer ?? eval(key).collection;
					for (const elementid of attached[key]) {
						let element = layer.get(elementid);
						if(!isLocked) TokenAttacher.lockElement(key, element, false);
						else TokenAttacher.lockElement(key, element, true);
					}
				}
			}
			if(!isLocked){
				icons[0].classList.toggle("hidden", true);
				icons[1].classList.toggle("hidden", false);
			}
			else{
				icons[0].classList.toggle("hidden", false);
				icons[1].classList.toggle("hidden", true);
			}
			token.setFlag(moduleName, "locked", !isLocked); 
		}

		static highlightAttached(token, button){
			const attached=token.getFlag(moduleName, "attached") || {};
			if(Object.keys(attached).length == 0) return;
			let icons = button.getElementsByTagName("i");
			const isHighlighted = icons[0].classList.contains("hidden");

			for (const key in attached) {
				if (attached.hasOwnProperty(key) && key !== "unknown") {
					let layer = eval(key).layer ?? eval(key).collection;
					for (const elementid of attached[key]) {
						let element = layer.get(elementid);
						if(!isHighlighted) element.alpha = 0.5;
						else element.alpha = 1;
					}
				}
			}
			if(!isHighlighted){
				icons[0].classList.toggle("hidden", true);
				icons[1].classList.toggle("hidden", false);
			}
			else{
				icons[0].classList.toggle("hidden", false);
				icons[1].classList.toggle("hidden", true);
			}
		}

		static async closeTokenAttacherUI(){
			TokenAttacher._updateAttachedOffsets(canvas.scene.getFlag(moduleName, "attach_base"));
			document.getElementById("tokenAttacher").remove();
			return await canvas.scene.unsetFlag(moduleName, "attach_base");		
		}

		static detachElementFromToken(element, target_token, suppressNotification=false){
			const type = element.constructor.name;
			const selected = [element.data._id];
			
			if(TokenAttacher.isFirstActiveGM()) TokenAttacher._DetachFromToken(target_token, {type:type, data:selected}, suppressNotification);
			else game.socket.emit(`module.${moduleName}`, {event: `DetachFromToken`, eventdata: [target_token.data._id, {type:type, data:selected}, suppressNotification]});
		}

		static detachElementsFromToken(element_array, target_token, suppressNotification=false){
			let selected = {}
			for (const element of element_array) {
				const type = element.constructor.name;
				if(!selected.hasOwnProperty(type)) selected[type] = [];
				selected[type].push(element.data._id);
			}
		
			if(TokenAttacher.isFirstActiveGM()) TokenAttacher._detachElementsFromToken(selected, target_token, suppressNotification);
			else game.socket.emit(`module.${moduleName}`, {event: `detachElementsFromToken`, eventdata: [selected, target_token.data._id, suppressNotification]});
		}

		static async _detachElementsFromToken(selected, target_token, suppressNotification=false){
			if(typeof target_token === 'string' || target_token instanceof String) target_token = canvas.tokens.get(target_token);
			for (const key in selected) {
				if (selected.hasOwnProperty(key)) {
					await TokenAttacher._DetachFromToken(target_token, {type:key, data:selected[key]}, suppressNotification);
				}
			}
		}

		static detachAllElementsFromToken(target_token, suppressNotification=false){			
			if(TokenAttacher.isFirstActiveGM()) TokenAttacher._DetachFromToken(target_token, {}, suppressNotification);
			else game.socket.emit(`module.${moduleName}`, {event: `DetachFromToken`, eventdata: [target_token.data._id, {}, suppressNotification]});
		}

		static getAllAttachedElementsOfToken(target_token, suppressNotification=false){
			return target_token.getFlag(moduleName, "attached") || {};
		}

		static getAllAttachedElementsByTypeOfToken(target_token, type, suppressNotification=false){
			return target_token.getFlag(moduleName, `attached.${type}`) || {};
		}

		/*
			Calculates the offset of and element relative to a position(center) and rotation
			x/y 		= offset of x/y of element to the passed center
			centerX/Y 	= offset of center x/y of element to the passed center
			rot			= initial rotation of the element
			offRot		= offset rotation of element to the passed rotation 
			size		= width/height/distance/dim/bright/radius of element and widthBase/heightBase of parent
		*/
		static getElementOffset(type, element, xy, center, rotation, size){
			let offset = {x:Number.MAX_SAFE_INTEGER, y:Number.MAX_SAFE_INTEGER, rot:Number.MAX_SAFE_INTEGER};
			offset.x = element.data.x || (element.data.c[0] < element.data.c[2] ? element.data.c[0] : element.data.c[2]);
			offset.y = element.data.y || (element.data.c[1] < element.data.c[3] ? element.data.c[1] : element.data.c[3]);
			offset.centerX = element.center.x;
			offset.centerY = element.center.y;
			offset.rot = element.data.rotation || element.data.direction || rotation;
			offset.offRot = element.data.rotation || element.data.direction || rotation;
			if(element.data.hasOwnProperty('c')){
				offset.c = [];
				offset.c[0] = element.data.c[0] - center.x;
				offset.c[2] = element.data.c[2] - center.x;
				offset.c[1] = element.data.c[1] - center.y;
				offset.c[3] = element.data.c[3] - center.y;
			}
			offset.x -= center.x; 
			offset.y -= center.y;
			offset.centerX -= center.x;
			offset.centerY -= center.y;
			offset.offRot -= rotation % 360;
			offset.rot %= 360;
			offset.offRot %= 360;

			offset.size = {};
			if(element.data.hasOwnProperty('width')){
				offset.size.width  	= element.data.width;
				offset.size.height	= element.data.height;
			}
			if(element.data.hasOwnProperty('distance')){
				offset.size.distance= element.data.distance;
			}
			if(element.data.hasOwnProperty('dim')){
				offset.size.dim= element.data.dim;
				offset.size.bright= element.data.bright;
			}
			if(element.data.hasOwnProperty('radius')){
				offset.size.radius= element.data.radius;
			}
			offset.size.widthBase = size.width;
			offset.size.heightBase = size.height;

			return offset;
		}

		static getElementSize(element){
			let size = {};
			size.width 	= element.data.width 	|| element.data.distance || element.data.dim || element.data.radius;
			size.height = element.data.height 	|| element.data.distance || element.data.dim || element.data.radius;
			return size;
		}

		static getObjectsFromIds(type, idArray){
			let layer = eval(type).layer ?? eval(type).collection;
			let copyArray = [];
			for (const elementid of idArray) {
				const element = layer.get(elementid);
				const elem_attached = element.getFlag(moduleName, "attached") || {};
				let dup_data = duplicate(element.data);
				delete dup_data._id;
				if(Object.keys(elem_attached).length > 0){
					const prototypeAttached = TokenAttacher.generatePrototypeAttached(element.data, elem_attached);
					delete dup_data.flags[moduleName].attached;
					dup_data.flags[moduleName].prototypeAttached = prototypeAttached;
				}
				copyArray.push(dup_data);
			}
			return copyArray;
		}

		static async copyAttached(token){
			let copyObjects = {};
			const attached=token.getFlag(moduleName, "attached") || {};
			if(Object.keys(attached).length == 0) return;
		
			for (const key in attached) {
				if (attached.hasOwnProperty(key) && key !== "unknown") {
					copyObjects[key] = TokenAttacher.getObjectsFromIds(key, attached[key]);
				}
			}
			await game.user.unsetFlag(moduleName, "copy");			
			await game.user.setFlag(moduleName, "copy", copyObjects);	
			ui.notifications.info(`Copied attached elements.`);	
		}

		static async pasteAttached(token){
			const copyObjects = duplicate(game.user.getFlag(moduleName, "copy")) || {};
			if(Object.keys(copyObjects).length == 0) return;
			TokenAttacher.saveBasePositon(token.constructor.name, token);
			//Set parent in copyObjects
			for (const key in copyObjects) {
				if (copyObjects.hasOwnProperty(key) && key !== "unknown") {
					for (let i = 0; i < copyObjects[key].length; i++) {
						copyObjects[key][i].flags[moduleName].parent = token.data._id;
					}
				}				
			}

			TokenAttacher.regenerateAttachedFromPrototype(token.constructor.name, token, copyObjects);
		}

		static async pasteObjects(layer, objects, pos, {hidden = false} = {}, return_data=false){
			if ( !objects.length ) return [];
			const cls = layer.constructor.placeableClass;

			// Iterate over objects
			const toCreate = [];
			for ( let dat of objects) {
				let data = duplicate(dat);
				delete data._id;
				if(cls.name == "Wall"){
					data.c = data.c.map((c, i) => {
						if(!(i%2)) return pos.x + data.flags[moduleName].offset.c[i];
						else	return pos.y + data.flags[moduleName].offset.c[i];
					});
					toCreate.push(data);
				}
				else{
					toCreate.push(mergeObject(data, {
						x: pos.x + data.flags[moduleName].offset.x,
						y: pos.y + data.flags[moduleName].offset.y,
						hidden: data.hidden || hidden
					}));
				}
			}

			if(return_data) return toCreate;
			// Create all objects
			const created = await canvas.scene.createEmbeddedEntity(cls.name, toCreate);
			//ui.notifications.info(`Pasted data for ${toCreate.length} ${cls.name} objects.`);
			return created;
		}

		static async updateAttachedPrototype(entity, data, options, userId){
			if(!TokenAttacher.isFirstActiveGM()) return;
			if(data.hasOwnProperty("token")){
				if(data.token.hasOwnProperty("flags")){
					if(data.token.flags.hasOwnProperty(moduleName)){
						const attached = data.token.flags[moduleName].attached || {};
						if(Object.keys(attached).length == 0) return;

						let prototypeAttached = TokenAttacher.generatePrototypeAttached(data.token, attached);
						let deletes = {_id:data._id, [`token.flags.${moduleName}.-=attached`]: null, [`token.flags.${moduleName}.-=prototypeAttached`]: null};
						let updates = {_id:data._id, [`token.flags.${moduleName}`]: {prototypeAttached: prototypeAttached, grid:{size:canvas.grid.size, w: canvas.grid.w, h:canvas.grid.h}}};
						await entity.update(deletes);
						await entity.update(updates);
					}
				}
			}
		}

		static generatePrototypeAttached(token_data, attached){
			let prototypeAttached = {};
			for (const key in attached) {
				if (attached.hasOwnProperty(key)) {
					prototypeAttached[key] = TokenAttacher.getObjectsFromIds(key, attached[key]);
				}
			}	
			return prototypeAttached;
		}

		static async copyTokens(layer, tokens){
			const copyPrototypeMap = game.user.getFlag(moduleName, "copyPrototypeMap") || {};
			const prototypeMap= {};
			tokens.forEach(token => {
				if(		token.data.flags.hasOwnProperty(moduleName)
					&& 	token.data.flags[moduleName].hasOwnProperty("attached")){
					prototypeMap[token.id] = TokenAttacher.generatePrototypeAttached(token.data, token.data.flags[moduleName].attached);
				}
			});
			copyPrototypeMap[layer.constructor.placeableClass.name] = prototypeMap;
			await game.user.unsetFlag(moduleName, "copyPrototypeMap");
			await game.user.setFlag(moduleName, "copyPrototypeMap", copyPrototypeMap);
		}

		static pasteTokens(copy, toCreate){
			const copyPrototypeMap = game.user.getFlag(moduleName, "copyPrototypeMap") || {};
			for (let i = 0; i < toCreate.length; i++) {
				if(		toCreate[i].flags.hasOwnProperty(moduleName)
					&& 	toCreate[i].flags[moduleName].hasOwnProperty("attached")){
					delete toCreate[i].flags[moduleName].attached;
					const clsname = copy[i].layer.constructor.placeableClass.name;
					if(copyPrototypeMap.hasOwnProperty(clsname))
						toCreate[i].flags[moduleName].prototypeAttached = copyPrototypeMap[clsname][copy[i].data._id];				
				}
			}
		}

		static async deleteToken(entity, token_data, userId){
			const attached=getProperty(token_data, `flags.${moduleName}.attached`) || {};
			if(Object.keys(attached).length == 0) return true;

			TokenAttacher.detectGM();

			for (const key in attached) {
				if (attached.hasOwnProperty(key)) {
					let layer = eval(key).layer ?? eval(key).collection;
					await layer.deleteMany(attached[key], {[moduleName]:true});
				}
			}
		}

		static async updateAttachedCreatedToken(type, parent, entity, options, userId){
			if(!TokenAttacher.isFirstActiveGM()) return;
			if(getProperty(options, "isUndo") === true && getProperty(options, "mlt_bypass") === true) return;
			if(getProperty(options, moduleName) === true) return;
			
			const token = canvas.tokens.get(entity._id);
			const prototypeAttached = token.getFlag(moduleName, "prototypeAttached") || {};
			const attached = token.getFlag(moduleName, "attached") || {};
			
			if(getProperty(options, "isUndo") === true){
				if(Object.keys(attached).length > 0){
					await TokenAttacher.regenerateAttachedFromHistory(token, attached);
				}
				return;
			}

			if(Object.keys(prototypeAttached).length > 0){ 
				await TokenAttacher.regenerateAttachedFromPrototype(type, token, prototypeAttached);
				//Migration code
				if(!getProperty(prototypeAttached[Object.keys(prototypeAttached)[0]][0], `data.flags.${moduleName}.parent`)) await TokenAttacher._updateAttachedOffsets({type:token.constructor.name ,element:token});
				//Migration code end
			}
			return;
		}
		static async regenerateAttachedFromPrototype(type, token, prototypeAttached, return_data = false){
			let pasted = {};
			let toCreate = {};
			for (const key in prototypeAttached) {
				if (prototypeAttached.hasOwnProperty(key) && key !== "unknown") {
					let layer = eval(key).layer ?? eval(key).collection;

					let pos = TokenAttacher.getCenter(type, token.data);
					if(!toCreate.hasOwnProperty(key)) toCreate[key] = [];
					toCreate[key] = await TokenAttacher.pasteObjects(layer, prototypeAttached[key], pos, {}, true);
					if(!toCreate[key]) delete toCreate[key];					
				}
			}

			
			for (const key in prototypeAttached) {
				for (let i = 0; i < prototypeAttached[key].length; i++) {
					const element = prototypeAttached[key][i];
					const element_protoAttached = getProperty(element, `flags.${moduleName}.prototypeAttached`);
					if(element_protoAttached){
						const toCreateElement = toCreate[key].find(item => getProperty(item , `flags.${moduleName}.pos.base_id`) === getProperty(element , `flags.${moduleName}.pos.base_id`));
						let subCreated = await TokenAttacher.regenerateAttachedFromPrototype(key, {data:toCreateElement}, element_protoAttached, true);
						for (const subKey in subCreated) {
							if (subCreated.hasOwnProperty(subKey)) {
								const element = subCreated[subKey];
								if(!toCreate.hasOwnProperty(subKey)) toCreate[subKey] = [];
								toCreate[subKey] = toCreate[subKey].concat(subCreated[subKey]);
							}
						}
					}
				}
			}
			if(return_data) return toCreate;

			pasted[token.constructor.name] = [];
			pasted[token.constructor.name].push(token.data);
			for (const key in toCreate) {
				if (toCreate.hasOwnProperty(key)) {
					const created = await canvas.scene.createEmbeddedEntity(key, toCreate[key], {[moduleName]:true});
					if(!pasted.hasOwnProperty(key)) pasted[key] = [];
					if(Array.isArray(created)) pasted[key] = pasted[key].concat(created);
					else pasted[key].push(created);
				}
			}

			console.log(pasted);
			//Fix connections
			await TokenAttacher.regenerateLinks(pasted);
			await token.unsetFlag(moduleName, "prototypeAttached");
			ui.notifications.info(`Pasted elements and attached to token.`);
			return;
		}

		static async regenerateLinks(pasted){
			let updates = {};
			const pushUpdate = (key, update) => {
				if(!updates.hasOwnProperty(key)) updates[key] = [];
				const dupIndex = updates[key].findIndex(item => update._id === item._id);
				if(dupIndex === -1) updates[key].push(update);
				else updates[key][dupIndex] = mergeObject(updates[key][dupIndex], update);
			};
			for (const key in pasted) {
				if (pasted.hasOwnProperty(key)) {
					const arr = pasted[key];
					for (let i = 0; i < arr.length; i++) {
						const base = arr[i];
						const old_base_id = getProperty(base , `flags.${moduleName}.pos.base_id`);
						if(old_base_id) {
							let current_attached = getProperty(base , `flags.${moduleName}.attached`);
							let new_attached = {}; 
							for (const attKey in pasted) {
								if (pasted.hasOwnProperty(attKey)) {
									new_attached[attKey] = pasted[attKey].filter(item => getProperty(item , `flags.${moduleName}.parent`) === old_base_id);;
									for (let j = 0; j < new_attached[attKey].length; j++) {
										const attached_element = new_attached[attKey][j];	
										let update =  {_id: attached_element._id};	
										update[`flags.${moduleName}.parent`] = base._id;
										pushUpdate(attKey, update);
									}
									new_attached[attKey] = new_attached[attKey].map(item => item._id);
									if(current_attached && current_attached.hasOwnProperty(attKey)){
										new_attached[attKey] = [...new Set(new_attached[attKey].concat(current_attached[attKey]))];
									}
								}
							}
							let update = {
								_id: base._id, 
								[`flags.${moduleName}.attached`]:new_attached, 
								[`flags.${moduleName}.pos.base_id`]:base._id,
								[`flags.${moduleName}.-=prototypeAttached`]: null,
								[`flags.${moduleName}.-=grid`]: null
							};
							pushUpdate(key, update);
						}				
					}
				}
			}
			//Fire updates
			for (const key in updates){
				if (updates.hasOwnProperty(key)) {
					await canvas.scene.updateEmbeddedEntity(key, updates[key]);
				}
			}
		}

		static async regenerateAttachedFromHistory(token, attached){
			TokenAttacher.detectGM();
			const newattached= {};
			for (const key in attached) {
				if (attached.hasOwnProperty(key) && attached[key].length > 0) {
					let layer = eval(key).layer ?? eval(key).collection;
					
					const undone = await layer.undoHistory();
					if(Array.isArray(undone)){
						newattached[key] = undone.map((obj)=>{
							return obj.data._id;
						});
					}
					else{
						newattached[key] = [undone.data._id];
					}
				}
			}
			
			await token.unsetFlag(moduleName, `attached`);
			await token.setFlag(moduleName, `attached`, newattached);
		}

		static mapActorForExport(actor){
			return {img:actor.data.img, name:actor.data.name, folder:actor.data.folder || null, token: actor.data.token};
		}

		static async getActorsWithPrototype(){
			const folders = {};
			const allActors = [...game.actors].filter(actor =>{
				const attached = getProperty(actor, `data.token.flags.${moduleName}.prototypeAttached`) || {};
				if(Object.keys(attached).length > 0) return true;
				return false;
			});
			const allMappedActors = allActors.map(TokenAttacher.mapActorForExport);

			let addParentFolder = (folders, folder) =>{
				const parent = game.folders.get(folder.data.parent) || null;
				if(parent){
					folders[parent.data._id] = parent;
					addParentFolder(folders, parent);
				}
			};

			allMappedActors.forEach(actor => {
				const folder = game.folders.get(actor.folder) || null;
				if(folder){
					folders[folder.data._id] = folder;
					addParentFolder(folders, folder);
				}
			});
			const html = await renderTemplate(`${templatePath}/ImExportUI.html`, {label_content:"Copy the JSON below:", content:JSON.stringify({folder: folders, actors: allMappedActors, ['data-model']: game.settings.get(moduleName, "data-model-version")})});
			Dialog.prompt({title:"Export Actors to JSON", callback: html => {}, content: html});
		}

		static async getActorsWithPrototypeInCompendiums(){
			const folders = {};
			const allCompendiums = [...game.packs].filter(pack =>{
				if(pack.metadata.entity !== "Actor") return false;
				return true;
			});
			
			for (let i = 0; i < allCompendiums.length; i++) {
				const pack = allCompendiums[i];
				const packIndex = await pack.getIndex();
				console.log(pack);
				console.log(packIndex);
				for (let j = 0; j < packIndex.length; j++) {
					const index = packIndex[j];
					const entity = await pack.getEntity(index._id);
					console.log(entity);
				}
			}
		}

		static async exportCompendiumToJSON(pack){
			const packIndex = await pack.getIndex();
			console.log(pack);
			console.log(packIndex);
			let actors = [];
			for (let j = 0; j < packIndex.length; j++) {
				const index = packIndex[j];
				const entity = await pack.getEntity(index._id);
				actors.push(TokenAttacher.mapActorForExport(entity));
				console.log(entity);
			}
			const html = await renderTemplate(`${templatePath}/ImExportUI.html`, {label_content:"Copy the JSON below:", content:JSON.stringify({compendium: {name:pack.metadata.name, label:pack.metadata.label}, actors: actors, ['data-model']: game.settings.get(moduleName, "data-model-version")})});
			Dialog.prompt({title:"Export Actors to JSON", callback: html => {}, content: html});
		}

		static async importFromJSONDialog(){
			const html = await renderTemplate(`${templatePath}/ImExportUI.html`, {label_content:"Paste JSON below:", content:""});
			Dialog.prompt({title:"Import Actors from JSON", 
			content: html,
			callback: html => {
				const form = html.find("#ta-import-export-dialog");
				const fd = new FormDataExtended(form[0]);
				const data = fd.toObject();
				if ( !data.JSONContent ) {
				  const err = new Error(game.i18n.localize("TOKENATTACHER.error.NoValidJSONProvided"));
				  return ui.notifications.warn(err.message);
				}
				TokenAttacher.importFromJSON(data.JSONContent);
			}
			});
		}
		static async importFromJSON(json, options={}){
			const imported = JSON.parse(json);
			if(imported.folder)	await TokenAttacher.importFromJSONWithFolders(imported, options);
			if(imported.compendium)	await TokenAttacher.importFromJSONWithCompendium(imported, options);
		}
		static async importFromJSONWithFolders(imported, options={}){
			const folders = imported.folder;
			const actors = imported.actors;
			 
			const parentMap = {null:{value:null}};
			let allPromises = [];
			for (const key in folders) {
				if (folders.hasOwnProperty(key)) {
					const folder = folders[key];
					allPromises.push((async (folder)=>{
						if(!parentMap.hasOwnProperty(folder.parent)) {
							let resolver;
							parentMap[folder.parent] = {value:new Promise((resolve)=>{resolver = resolve}), signal: resolver};
						}
						const parent = await parentMap[folder.parent].value;
						const newFolder = await Folder.create({name: folder.name, type: "Actor", parent: parent});
						if(!parentMap.hasOwnProperty(folder._id)) {
							parentMap[folder._id] = {value:new Promise((resolve) => (resolve(newFolder._id)))};
						}
						else {
							parentMap[folder._id].signal(newFolder._id);
						}
					})(folder));
				}
			}
			await Promise.all(allPromises);
			actors.forEach(async actor => {
				await Actor.create({type: game.system.entityTypes.Actor[0], img:actor.img, name:actor.name, folder:await parentMap[actor.folder].value, token: actor.token});
			});
		}

		static async importFromJSONWithCompendium(imported, options={}){
			const compendium = imported.compendium;
			const actors = imported.actors;
			let name = compendium.name;
			let label = compendium.label;
			if(options.hasOwnProperty("module")) name = options.module + "." + name;
			if(options.hasOwnProperty("module-label")) label = "("+options["module-label"] + ")" + label;
			 
			const parentMap = {null:{value:null}};
			let worldCompendium = await Compendium.create({label:label, name: name, entity:"Actor"});
			let creates = [];
			actors.forEach(async actor => {
				creates.push({type: game.system.entityTypes.Actor[0], img:actor.img, name:actor.name, token: actor.token});
			});
			// if(!imported.hasOwnProperty('data-model') || imported['data-model'] !== game.settings.get(moduleName, "data-model-version")){
			// 		//Maybe add some compendium migration code if necessary	
			// }
			return await worldCompendium.createEntity(creates);
		}
		
		//Attached elements are only allowed to be moved by token attacher functions.
		static isAllowedToMove(parent, doc, update, options, userId){
			if(!(	update.hasOwnProperty("x")
				||	update.hasOwnProperty("y")
				||	update.hasOwnProperty("rotation"))){
				return true;
			}
			let offset = getProperty(getProperty(getProperty(doc, 'flags'), moduleName), 'offset') || {};
			if(Object.keys(offset).length === 0) return true;
			if(getProperty(options, moduleName)) return true;
			let objParent = getProperty(getProperty(getProperty(doc, 'flags'), moduleName), 'parent') || "";
			if(document.getElementById("tokenAttacher")) return TokenAttacher.isCurrentAttachUITarget(objParent);
			return false;
		}

		//Attached elements are only allowed to be selected while token attacher ui is open.
		static isAllowedToControl(object, isControlled){
			let offset = object.getFlag(moduleName, 'offset') || {};
			if(Object.keys(offset).length === 0) return;
			let objParent = object.getFlag(moduleName, 'parent') || {};
			if(document.getElementById("tokenAttacher") && TokenAttacher.isCurrentAttachUITarget(objParent)) return;
			return object.release();
		}

		static isCurrentAttachUITarget(id){
			return canvas.tokens.get(canvas.scene.getFlag(moduleName, "attach_base").element).data._id === id;
		}

		//Detach Elements when they get deleted
		static DetachAfterDelete(type, parent, doc, options, userId){
			if(!TokenAttacher.isFirstActiveGM()) return; 
			if(getProperty(options, moduleName)) return;
			let objParent = getProperty(getProperty(getProperty(doc, 'flags'), moduleName), 'parent') || "";
			if(objParent !== ""){
				if(TokenAttacher.isFirstActiveGM()) TokenAttacher._DetachFromToken(objParent, {type:type, data:[doc._id]}, true);
				else game.socket.emit(`module.${moduleName}`, {event: `DetachFromToken`, eventdata: [objParent, {type:type, data:[doc._id]}, true]});
			}
		}

		//Reattach elements that are recreated via Undo
		static ReattachAfterUndo(type, parent, entity, options, userId){
			if(TokenAttacher.isFirstActiveGM()) return;
			let objParent = getProperty(getProperty(getProperty(entity, 'flags'), moduleName), 'parent') || "";
			if(!objParent) return;
			if(getProperty(options, "isUndo") === true){
				if(getProperty(options, "mlt_bypass") === true) return;

				if(TokenAttacher.isFirstActiveGM()) TokenAttacher._ReattachAfterUndo(type, parent, entity, options, userId);
				else game.socket.emit(`module.${moduleName}`, {event: `ReattachAfterUndo`, eventdata: [type, parent, entity, options, userId]});
			}
			return;
		}

		//Reattach elements that are recreated via Undo or remove the attachment completly if the base doesn't exist anymore
		static async _ReattachAfterUndo(type, parent, entity, options, userId){
			let objParent = getProperty(getProperty(getProperty(entity, 'flags'), moduleName), 'parent') || "";
			const parent_token = canvas.tokens.get(objParent);
			if(parent_token){
				TokenAttacher._AttachToToken(parent_token, {type:type, data:[entity._id]}, true);
			}
			else{
				let layer = eval(type).layer ?? eval(type).collection;
				const element = layer.get(entity._id);
				
				const deletes ={[`flags.${moduleName}.-=parent`]: null, [`flags.${moduleName}.-=offset`]: null};
				await element.update(deletes);
			}
		}

		//Rectangle Selection hook to select and attach every element on every layer inside the rectangle 
		static async _RectangleSelection(event){
			const tool = game.activeTool;
			if(tool !== "select") return;
			if($(document.getElementById("tokenAttacher")).find(".control-tool.select.active").length <= 0 ) return;
			$(document.getElementById("tokenAttacher")).find(".control-tool.select")[0].classList.toggle("active");	
			
			const {coords, originalEvent} = event.data;
			const {x, y, width, height, releaseOptions={}, controlOptions={}}=coords;
			let selected = {};	
			const baseId= canvas.scene.getFlag(moduleName, "attach_base").element;		
			const token = canvas.tokens.get(baseId);
			for (const type of ["AmbientLight", "AmbientSound", "Drawing", "MeasuredTemplate", "Note", "Tile", "Token", "Wall"]) {
				const layer = canvas.getLayerByEmbeddedName(type);
				//if (layer.options.controllableObjects) {
					// Identify controllable objects
					const controllable = layer.placeables.filter(obj => obj.visible && (obj.control instanceof Function));
					const newSet = controllable.filter(obj => {
						let c = obj.center;
						//filter base out
						if(obj.data._id === baseId) return;
						//Filter attached elements except when they are already attached to the base
						const parent = obj.getFlag(moduleName, 'parent') || "";
						if(parent !== "" && parent !== baseId) return;
						//filter all inside selection
						return Number.between(c.x, x, x+width) && Number.between(c.y, y, y+height);
					});		
					selected[type] = newSet.map(a => a.data._id);
					if(selected[type].length <= 0) delete selected[type];		
				//}
			}
			if(selected.length === 0) return;
			TokenAttacher._attachElementsToToken(selected, token, false);
		}

		static areDuplicatesInAttachChain(base, attached){
			//Check if base tried to attach itself
			const type = base.constructor.name;
			const att = getProperty(attached, type) || [];
			if(att.indexOf(base.data._id) !== -1) return base;

			let bases = {};
			let duplicate = null;
			//Add base to bases object and return true when no duplicate was found
			const add_base = (element) => {
				const type = element.constructor.name;
				if(!bases.hasOwnProperty(type)) bases[type] = {};
				if(!bases[type].hasOwnProperty(element.data._id)){
					bases[type][element.data._id] = 1;
					return true;
				}
				return false;
			}

			add_base(base);

			for (const key in attached) {
				if (attached.hasOwnProperty(key) && key !== "unknown") {
					let layer = eval(key).layer ?? eval(key).collection;
					for (const elementid of attached[key]) {
						let element = layer.get(elementid);
						const elementAttached = element.getFlag(moduleName, "attached") || {};
						if(Object.keys(elementAttached).length > 0){
							if(!add_base(element)){
								return element;
							}
						}
					}
				}
			}
			return false;
		}

		static getCenter(type, data, grid = {w: canvas.grid.w, h:canvas.grid.h}){
			const [x,y] = [data.x, data.y];
			let center = {x:x, y:y};
			//Tokens, Tiles
			if ( "width" in data && "height" in data ) {
				let [width, height] = [data.width, data.height];
				if(type !== "Tile") [width, height] = [width * grid.w, height * grid.h]
				center={x:x + (width / 2), y:y + (height / 2)};
			}
			//Walls
			if("c" in data){
				center = {x:(data.c[0] + data.c[2]) / 2, y: (data.c[1] + data.c[3]) / 2}
			}
			return center;
			
		}
	}

	TokenAttacher.registerHooks();
})();