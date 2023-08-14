"use strict";

class Mod {
	// container to use outside pre-, post- loads
	static container;
	
	preAkiLoad(container) {
		// safe this reference to use instead of normal container
		Mod.container = container;
		
		// do the good old swaperoo
		container.afterResolution("InraidController", (_t, result) => {
			result.savePmcProgress = (sessionID, offraidData) => {
				return Mod.customSavePmc(sessionID, offraidData)
			}
		}, {frequency: "Always"});
	}
	
	postDBLoad(container) {
		// constants
		const logger = container.resolve("WinstonLogger");
		const database = container.resolve("DatabaseServer").getTables();
		const config = require("../config/config.json");
		const viableMaps = ["bigmap", "factory4_day", "factory4_night", "interchange", "lighthouse", "rezervbase", "shoreline", "woods"];
		
		// if default insurance is turned off, make it false in map files
		// dont handle labs, base game already has it at false
		if (!config.EnableDefaultInsurance) {
			for (const map in database.locations) {
				if (viableMaps.includes(map)) {
					database.locations[map].base.Insurance = false;
				}
			}
		}
	}
	
	static customSavePmc(sessionID, offraidData) {
		// resolve original container
		const inraidController = Mod.container.resolve("InraidController");
		
		const currentProfile = inraidController.saveServer.getProfile(sessionID);
		const locationName = currentProfile.inraid.location.toLowerCase();
		const config = require("../config/config.json");

		const map = inraidController.databaseServer.getTables().locations[locationName].base;
		const insuranceEnabled = map.Insurance;
		let pmcData = currentProfile.characters.pmc;
		const isDead = inraidController.isPlayerDead(offraidData.exit);
		const preRaidGear = inraidController.inRaidHelper.getPlayerGear(pmcData.Inventory.items);
		const preRaidInsuredItems = JSON.parse(JSON.stringify(pmcData.InsuredItems));

		currentProfile.inraid.character = "pmc";

		pmcData = inraidController.inRaidHelper.updateProfileBaseStats(pmcData, offraidData, sessionID);

		// Check for exit status
		inraidController.markOrRemoveFoundInRaidItems(offraidData, pmcData, false);

		offraidData.profile.Inventory.items = inraidController.itemHelper.replaceIDs(offraidData.profile, offraidData.profile.Inventory.items, pmcData.InsuredItems, offraidData.profile.Inventory.fastPanel);
		inraidController.inRaidHelper.addUpdToMoneyFromRaid(offraidData.profile.Inventory.items);

		pmcData = inraidController.inRaidHelper.setInventory(sessionID, pmcData, offraidData.profile);
		inraidController.healthHelper.saveVitality(pmcData, offraidData.health, sessionID);

		// remove inventory if player died and send insurance items
		if (isDead) {
			inraidController.pmcChatResponseService.sendKillerResponse(sessionID, pmcData, offraidData.profile.Stats.Aggressor);
            inraidController.matchBotDetailsCacheService.clearCache();
			
			pmcData = Mod.customPostDeath(offraidData, pmcData, insuranceEnabled, preRaidGear, sessionID);
		}
		
		const victims = offraidData.profile.Stats.Victims.filter(x => x.Role === "sptBear" || x.Role === "sptUsec");
        if (victims?.length > 0) {
            inraidController.pmcChatResponseService.sendVictimResponse(sessionID, victims, pmcData);
        }
		
		// save post raid gear after you're done with deleting non insured items
		const postRaidGear = pmcData.Inventory.items;
		
		
		if (config.EnableDefaultInsurance) {
			if (insuranceEnabled) {
				Mod.customStoreLostGear(pmcData, postRaidGear, preRaidGear, preRaidInsuredItems, sessionID, isDead, offraidData);
				inraidController.insuranceService.sendInsuredItems(pmcData, sessionID, map.Id);
			} else {
				inraidController.insuranceService.sendLostInsuranceMessage(sessionID);
			}
		}
	}
	
	static customPostDeath(postRaidSaveRequest, pmcData, insuranceEnabled, preRaidGear, sessionID) {
		// resolve og container
		const inraidController = Mod.container.resolve("InraidController");
		
		inraidController.updatePmcHealthPostRaid(postRaidSaveRequest, pmcData);		
		pmcData = Mod.customDeleteInv(pmcData, sessionID);

		// Remove quest items
        if (inraidController.inRaidHelper.removeQuestItemsOnDeath()) {
            for (const questItem of postRaidSaveRequest.profile.Stats.CarriedQuestItems) {
                const findItemConditionIds = inraidController.questHelper.getFindItemIdForQuestHandIn(questItem);
                inraidController.profileHelper.resetProfileQuestCondition(sessionID, findItemConditionIds);
            }

            pmcData.Stats.CarriedQuestItems = [];
        }

		return pmcData;
	}
	
	static customDeleteInv(pmcData, sessionID) {
		// resolve required containers, yada yada
		const inRaidHelper = Mod.container.resolve("InRaidHelper");
		const logger = Mod.container.resolve("WinstonLogger");
		const database = Mod.container.resolve("DatabaseServer").getTables();
		const config = require("../config/config.json");
		
		const insuredItems = [];
		let deleteObj = {
			"DeleteItem": [],
			"DeleteInsurance": []
		};
		const dbParentIdsToCheck = [
			"5795f317245977243854e041",	// Container
			"5448e54d4bdc2dcc718b4568",	// Armor
			"5448e5284bdc2dcb718b4567",	// Vest
			"5448e53e4bdc2d60728b4567",	// Backpack
			"5a341c4086f77401f2541505",	// Headwear
			"5447bed64bdc2d97278b4568",	// Machine Guns
			"5447b6254bdc2dc3278b4568",	// Snipers Rifles
			"5447b5e04bdc2d62278b4567",	// Smgs
			"5447b6094bdc2dc3278b4567",	// Shotguns
			"5447b5cf4bdc2d65278b4567",	// Pistol
			"5447b6194bdc2d67278b4567",	// Marksman Rifles
			"5447b5f14bdc2d61278b4567",	// Assault Rifles
			"5447b5fc4bdc2d87278b4567",	// Assault Carbines
			"617f1ef5e8b54b0998387733"	// Revolvers
		];
		
		// dump all insured items in a simple array
		for (const insItem of pmcData.InsuredItems) {
			insuredItems.push(insItem.itemId);
		}

		for (const item of pmcData.Inventory.items) {
			
			// loop through inventory items
			if (item.parentId === pmcData.Inventory.equipment) {
				// add equipped insured items to an insurance delete array
				if (insuredItems.includes(item._id)) {
					deleteObj.DeleteInsurance.push(item._id);
				}
				
				// handle them pockets
				if (item.slotId.startsWith("Pockets")) {
					deleteObj = Mod.handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, deleteObj);
				}
				
				// push uninsured item to delete array
				if (!inRaidHelper.isItemKeptAfterDeath(pmcData, item) && !insuredItems.includes(item._id) || item.parentId === pmcData.Inventory.questRaidItems) {
					deleteObj.DeleteItem.push(item._id);
				}
				
				// Remove items inside gear items
				if (item.slotId != "hideout" && item.slotId != "FirstPrimaryWeapon" && item.slotId != "SecondPrimaryWeapon" && item.slotId != "Holster" && !inRaidHelper.isItemKeptAfterDeath(pmcData, item)) {
					deleteObj = Mod.handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, deleteObj);
				}
				
				// handle equipped guns, since we don't want want them becoming unoperable in player hands
				if (item.slotId === "FirstPrimaryWeapon" || item.slotId === "SecondPrimaryWeapon" || item.slotId === "Holster") {
					deleteObj = Mod.handleEquippedGuns(pmcData, item, insuredItems, dbParentIdsToCheck, database, deleteObj);
				}
			}
		}
		
		// remove insurance from equipped items
		if (config.LoseInsuranceOnItemAfterDeath) {
			pmcData.InsuredItems = Mod.removeInsurance(pmcData.InsuredItems, deleteObj.DeleteInsurance)
		}

		// delete items
		for (const item of deleteObj.DeleteItem) {
			inRaidHelper.inventoryHelper.removeItem(pmcData, item, sessionID);
		}

		pmcData.Inventory.fastPanel = {};

		return pmcData;
	}
	
	static customStoreLostGear(pmcData, postRaidGear, preRaidGear, preRaidInsuredItems, sessionID, playerDied, offraidData) {
		// resolve required container, yada yada
		const insuranceService = Mod.container.resolve("InsuranceService");
		
		const preRaidGearHash = insuranceService.createItemHashTable(preRaidGear);
		const offRaidGearHash = insuranceService.createItemHashTable(postRaidGear);
		
		const equipmentToSendToPlayer = [];

		for (const insuredItem of preRaidInsuredItems) {
			
			// Skip insured items not on player when they started raid
            const preRaidItem = preRaidGearHash[insuredItem.itemId];
            if (!preRaidItem)
            {
                continue;
            }
			
			// Skip items we should never return
            if (insuranceService.insuranceConfig.blacklistedEquipment.includes(preRaidItem.slotId))
            {
                continue;
            }
			
			if (preRaidGearHash[insuredItem.itemId]) {
				// This item exists in preRaidGear, meaning we brought it into the raid...
				// Check if we brought it out of the raid
				if (!offRaidGearHash[insuredItem.itemId] || playerDied) {
					// We didn't bring this item out! We must've lost it.
					equipmentToSendToPlayer.push({
						pmcData: pmcData,
						itemToReturnToPlayer: insuranceService.getInsuredItemDetails(pmcData, preRaidItem, offraidData.insurance?.find(x => x.id === insuredItem.itemId)),
						traderId: insuredItem.tid,
						sessionID: sessionID
					});
				}
			}
		}

		for (const gear of equipmentToSendToPlayer) {
			insuranceService.addGearToSend(gear);
		}
	}
	
	static handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, returnObj) {
		for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
			// Don't delete items in special slots
			// also skip insured items
			if (!itemInInventory.slotId.includes("SpecialSlot")) {
				
				// add equipped insured items to an insurance delete array
				if (insuredItems.includes(itemInInventory._id)) {
					returnObj.DeleteInsurance.push(itemInInventory._id);
				}
				
				if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id)) {
					returnObj.DeleteItem.push(itemInInventory._id);
				} else if (dbParentIdsToCheck.includes(database.templates.items[itemInInventory._tpl]._parent)) {
					returnObj = Mod.handleInventoryItems(pmcData, itemInInventory, insuredItems, dbParentIdsToCheck, database, returnObj)
				}
			}
		}
		
		return returnObj;
	}
	
	
	// TO-DO
	// this goes through bunch of useless loops, find where and remove
	static handleEquippedGuns(pmcData, item, insuredItems, dbParentIdsToCheck, database, returnObj) {
		const logger = Mod.container.resolve("WinstonLogger");
		
		for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
			
			
			
			// skip if its ammo, we want to keep it
			if (database.templates.items[itemInInventory._tpl]._parent === "5485a8684bdc2da71d8b4567") {
				continue;
			}
			
			// add to insured array if insured
			if (insuredItems.includes(itemInInventory._id)) {
				returnObj.DeleteInsurance.push(itemInInventory._id);
			}
			
			if (database.templates.items[item._tpl]._props.Slots.length != 0) {
				for (const slotsIndex in database.templates.items[item._tpl]._props.Slots) {
					if (database.templates.items[item._tpl]._props.Slots[slotsIndex]._props.filters[0].Filter.includes(itemInInventory._tpl)) {
						
						// check if the item is required, like pistol grips, gasblocks, etc
						if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id) && database.templates.items[item._tpl]._props.Slots[slotsIndex]._required === false) {
							returnObj.DeleteItem.push(itemInInventory._id);
							break;
						}
					}
				}
			} else if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id)) {
				returnObj.DeleteItem.push(itemInInventory._id);
			}
			
			// if item can have slots and is insured, call this function again
			if (database.templates.items[itemInInventory._tpl]._props.Slots.length != 0 && insuredItems.includes(itemInInventory._id)) {
				returnObj = Mod.handleEquippedGuns(pmcData, itemInInventory, insuredItems, dbParentIdsToCheck, database, returnObj)
			}
			
		}
		
		return returnObj;
	}
	
	static removeInsurance(insuredItemsList, itemsToRemove) {
		const returnList = insuredItemsList.filter(entry => !itemsToRemove.includes(entry.itemId));
		
		return returnList;
	}
	
}

	
module.exports = { mod: new Mod() }