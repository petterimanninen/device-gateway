'use strict';

// allow sef-signed certificate
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Avoids DEPTH_ZERO_SELF_SIGNED_CERT error for self-signed certs, not for prod!!!!

// Config for IoTCS instance
// Read Environment Parameters from Oracle Application Container Cloud Service (ACCS)
// If no env variables are there, use default values.
var port = Number(process.env.PORT || 8080);
//var iotaddr = process.env.IOTADDR ||"https://X.X.X.X:443"; // my iot cloud base URL
//var iotuser = process.env.IOTUSER || "user";  // username for iot cloud
//var iotpass = process.env.IOTPASS || "password"; // password for iot cloud

// Setup node & express
var express = require('express');
var bodyParser = require('body-parser');
var app = express();
var cors = require('cors');
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());
app.use(cors());

// Setup for IoT Cloud services - javascript client
var IoTServer = require('./jsclient/iot.js');


////////////////////////////////////////////////////////////////////////////////////////////
var sharedSecret = "secret"; // used for initiating communication with iotcs
var deviceId = null; // device id found by list devices
var device = null; // device connection
/*
var deviceMetadata = // device metadata - device serial number must be unique for all similar devices
{
  manufacturer: "Manufacturer",
  description: "Device Description",
  modelNumber: "Device Model",
  serialNumber: "Device Unique Serial Number" // has to be unique
};
*/

function DeviceMetadata(manufacturer, description, modelNumber, serialNumber)
{
	this.manufacturer = manufacturer;
	this.description = description;
	this.modelNumber = modelNumber;
	this.serialNumber = serialNumber; // filled when activated, must be unique
}

var photonMetadata = new DeviceMetadata("Particle", "Photon with temperature, humidity and luminosity sensors", "Particle Photon","");
var electronMetadata = new DeviceMetadata("Particle", "Electron with temperature, humidity, luminosity and movement sensors + battery level(0-85,100=ext.power)", "Particle Electron","");
var xkitMetadata = new DeviceMetadata("Thinxtra", "Thinxtra XKit with temperature, pressure and luminosity sensors", "Thinxtra XKit","");

// prevent multiple parallel activations for same device - particle sends multiple messages in sequence
// should use a better semaphore but maybe later ...
var inActivation = 0;
var inActivationId = "";

// login to iotcs
var iot = new IoTServer(iotaddr);
iot.setPrincipal(iotuser, iotpass);

// send incoming messages from gateway to iotcs
function sendToIotCS(iotDeviceId, iotDeviceName, iotDeviceUrn, iotDataUrn, iotPayload, deviceMetadata)
{
	// search for an activated device with right name = name + particle code id
	var query ={"name":iotDeviceId,"state":"ACTIVATED"};
	
	iot.listDevices(query,0,100)
		.then(function (data) { // device found - get device id. There should be only one id with this name!
			console.log( data.count + " devices found.");
			// console.log( "list of devices =" + JSON.stringify(data));
			console.log( "device id = " + data.items[0].id); // pick the first one as there should be only one ...
			// set device id - iotcs knows the device by this unique id
			deviceId = data.items[0].id;
			
			// open connection for this device
			console.log("open device " + deviceId);
			iot.getDevice(deviceId, sharedSecret)
				.then(function(device) {
					console.log( "Opened Directly Connected Device: " + device.getID())
					return device;
				})
				.then(function (device) {
					// send data to iotcs
					console.log("Sending message...");
					// console.log("ready to send format="+iotDataUrn+" data="+JSON.stringify(iotPayload)+ " to device " + device.getID() );
					// send message payload and corresponding data format, similar to "urn:particle:wifi:format" and {temperature: 18.2}
					// payload can be an array like [{temperature: 18.2}, {temperature: 16}, {temperature: 11}];
					return device.sendDataMessages(iotDataUrn, iotPayload);
				})
				.then(function (reply) {
					// done
					console.log("Message sent to device, reply " + JSON.stringify(reply) );
				})
				.catch(function (error) {
					// something went wrong
					console.log("*** Error while sending message to iotcs from a known device ***");
					console.log(error.body || error);
					console.trace();
				}
			);
			
		})
		.catch(function(error) { // device not registered (or something else went wrong - room to improvement here, should use real locking ...)
			// check for ongoing activation for this device
			if(inActivation && inActivationId == iotDeviceId) // prevent parallel activations for this device id
			{
				while(inActivation) // wait until previous activation is complete
				{
					console.log("waiting for activation to complete for device " + iotDeviceId);
					for(var i=5000+new Date().getTime(),j=i; j<=i;j=new Date().getTime()); // sleep 5s. ;)
				}
				console.log("wait complete - activation done for device " + iotDeviceId + ", resending"); // activation was completed, send data ...
				sendToIotCS(iotDeviceId, iotDeviceName, iotDeviceUrn, iotDataUrn, iotPayload);
				return;
			}
			else // lock until activated
			{
				inActivation++;
				inActivationId = iotDeviceId;
			}

			// no activated device, activate now
			console.log("no devices found, activating ...");
			
			// register and activate device, set metadata
			deviceMetadata.serialNumber = iotDeviceId; // has to be unique, value from device
			console.log("Device metadata: " + JSON.stringify(deviceMetadata));

			// register new device, a directly connected device
			iot.createDevice(sharedSecret, iotDeviceId, "DIRECTLY_CONNECTED_DEVICE", deviceMetadata)
				.then(function (device) {
					// set device id - iotcs knows the device by this unique id
					deviceId = device.getID();
					console.log("Directly Connected Device created: " + device.getID() );
					// get activation token, similar to {"Authorization":"Bearer 26c758338c5597061fee574146ad7819","X-ActivationId":"928AD990-8CE7-4E9B-9660-C6E02F47525E"}
					return device.requestActivationToken();
				})
				.then(function (device) {
					console.log("Activation token acquired: " + JSON.stringify(device.getAuthorizationHeaders()) );
					// get security policy, similar to {"format":"X.509","keyType":"RSA","keySize":2048,"hashAlgorithm":"SHA256withRSA"}
					return device.requestActivationPolicy();
				})
				.then(function (device) {
					console.log("Activation policy acquired: " + JSON.stringify(device.getActivationPolicy()) );
					
					// activate the device, set model with device urn, similar to "urn:particle:wifi"
					return device.activate(iotDeviceUrn);
				})
				.then(function (device) {
					console.log("Device Activated: " + device.getState() );
					// get a big boy token (jwt session token)
					return device.requestToken();
				})
				.then(function (device) {
					console.log("Sending messages...");
					// send message payload and corresponding data format, similar to "urn:particle:wifi:format" and {temperature: 18.2}
					// payload can be an array as well, similar to [{temperature: 18.2}, {temperature: 16}, {temperature: 11}];
					return device.sendDataMessages(iotDataUrn, iotPayload);
				})
				.then(function (device) {
					// done
					console.log("Messages sent.");
				})
				.catch(function (error) {
					// something went wrong
					console.log("*** Error when registering a new device to iotcs ***");
					console.log(error.body || error);
					console.trace();
				}
			);
			// relese activation lock
			inActivation--;
			inActivationId ="";
		});
}




// data coming in from partice, sending it to iotcs
// Particle payload
// {
//   "name": "{{PARTICLE_EVENT_NAME}}",
//   "data": "{{PARTICLE_EVENT_VALUE}}",
//   "coreid": "{{PARTICLE_DEVICE_ID}}",
//   "published_at": "{{PARTICLE_PUBLISHED_AT}}"
// }

// wait for incoming messages from particle.io
app.post('/photon', function (req, res) {
	var iotDeviceUrn = "urn:particle:photon";
	var iotDataUrn   = "urn:particle:photon:format";
	var iotDeviceName = "Particle Photon";
	
	// data model for particle: { "temperature" : 0, "humidity" : 0, "lumiosity" : 0 };
	var iotPayload = "";

	// pick up payload from particle.io
    var payload = req.body;
	
	console.log("payload body="+JSON.stringify(req.body));
	console.log("coreid="+payload.coreid);
	console.log("event="+payload.event);
	console.log("data="+payload.data);
	console.log("time="+payload.published_at);

	// set device device id for this device
	var iotDeviceId = "ParticleWifi_"+payload.coreid;
	switch(payload.event) {
		case "Temp":
			iotPayload = { temperature : payload.data };
			break;
		case "Humidity":
			iotPayload = { humidity : payload.data };
			break;
		case "Light":
			iotPayload = { luminosity : payload.data };
			break;
		case "Data":
			var sensorData = JSON.parse(payload.data);
			console.log("data.temperature = " + sensorData.temperature);
			console.log("data.humidity    = " + sensorData.humidity);
			console.log("data.luminosity   = " + sensorData.luminosity);
			iotPayload = {temperature : sensorData.temperature, humidity : sensorData.humidity, luminosity : sensorData.luminosity};
			break;
		default:
			iotPayload = {};
			break;
	}

	console.log("Send to iotcs: " + iotDeviceName + "(" + iotDeviceId + ") urn(" + iotDeviceUrn + ") data(" + iotDataUrn + ") message:" + JSON.stringify(iotPayload));
    sendToIotCS(iotDeviceId, iotDeviceName, iotDeviceUrn, iotDataUrn, iotPayload, photonMetadata);

    // Respond async.  No need for transactional.
    res.send(JSON.stringify({ result: "Success"}));
    res.end();
});

// wait for incoming messages from particle.io
app.post('/electron', function (req, res) {
	var iotDeviceUrn = "urn:particle:electron:3glogger";
	var iotDataUrn   = "urn:particle:electron:3glogger:format";
	var iotDeviceName = "Particle Electron";
	
	// data model for particle: { "temperature" : 0, "humidity" : 0, "lumiosity" : 0 };
	var iotPayload = "";

	// pick up payload from particle.io
    var payload = req.body;
	
	console.log("payload body="+JSON.stringify(req.body));
	console.log("coreid="+payload.coreid);
	console.log("event="+payload.event);
	console.log("data="+payload.data);
	console.log("time="+payload.published_at);

	// set device device id for this device
	var iotDeviceId = "Particle_Electron_3gLogger_"+payload.coreid;
	switch(payload.event) {
		case "Temp":
			iotPayload = { temperature : payload.data };
			break;
		case "Humidity":
			iotPayload = { humidity : payload.data };
			break;
		case "Light":
			iotPayload = { luminosity : payload.data };
			break;
		case "Data":
			var sensorData = JSON.parse(payload.data);
			console.log("data.temperature  = " + sensorData.temp);
			console.log("data.humidity     = " + sensorData.hum);
			console.log("data.luminosity   = " + sensorData.lum);
			console.log("data.movement     = " + sensorData.pir);
			console.log("data.power        = " + sensorData.pwr);
			iotPayload = {
				temperature : sensorData.temp, 
				humidity : sensorData.hum, 
				luminosity : sensorData.lum,
				movement : sensorData.pir,
				power : sensorData.pwr
			};
			break;
		default:
			iotPayload = {};
			break;
	}

	console.log("Send to iotcs: " + iotDeviceName + "(" + iotDeviceId + ") urn(" + iotDeviceUrn + ") data(" + iotDataUrn + ") message:" + JSON.stringify(iotPayload));
    sendToIotCS(iotDeviceId, iotDeviceName, iotDeviceUrn, iotDataUrn, iotPayload, electronMetadata);

    // Respond async.  No need for transactional.
    res.send(JSON.stringify({ result: "Success"}));
    res.end();
});



// wait for incoming messages from sigfox xkit
app.post('/xkit', function (req, res) {
	var iotDeviceUrn = "urn:thinxtra:xkit";
	var iotDataUrn   = "urn:thinxtra:xkit:format";
	var iotDeviceName = "thinxtra";
	
	// data model for xkit: { "temperature" : 0, "pressure" : 0, "luminosity" : 0, accelerationX : 0, accelerationY : 0, accelerationZ : 0};
	var iotPayload = "";

    var payload = req.body;
	
	console.log("payload body="+JSON.stringify(req.body));

    // Modify the data based on Sigfox spec:
    payload.temperature = payload.temperature/100;
    payload.pressure = payload.pressure*3;
    payload.photo = payload.photo/1000;
    payload.x_accelerator = payload.x_accelerator/250;
    payload.y_accelerator = payload.y_accelerator/250;
    payload.z_accelerator = payload.z_accelerator/250;

	var iotDeviceId = "xkit_"+req.body.device;
	iotPayload = {temperature : payload.temperature, pressure : payload.pressure, luminosity : payload.photo, accelerationX : payload.x_accelerator,  accelerationY : payload.y_accelerator,  accelerationZ : payload.z_accelerator };

	console.log("Send to iotcs: " + iotDeviceName + "(" + iotDeviceId + ") urn(" + iotDeviceUrn + ") data(" + iotDataUrn + ") message:" + JSON.stringify(iotPayload));
    sendToIotCS(iotDeviceId, iotDeviceName, iotDeviceUrn, iotDataUrn, iotPayload, xkitMetadata);

    // Respond async.  No need for transactional.
    res.send(JSON.stringify({ result: "Success"}));
    res.end();
});

app.post('/test', function (req, res) {
    res.send(JSON.stringify({ result: "Success"}));
    res.end();
});

app.get('/test', function (req, res) {
    res.send(JSON.stringify({ result: "Success"}));
    res.end();
});

app.get('/', function (req, res) {
    res.send("<html><head><title>PMa IoTCS GW</title><body><p>This gateway accepts POSTs to /photon /electron /xkit /test and GETs to /test</p></body></html>");
    res.end();
});


//////////////////////////////////////////////////////////
// Start listener
//////////////////////////////////////////////////////////
var server = app.listen(port, function () {
  console.log("App listening on port %s", port);
  console.log("Listening for POSTs to '/photon /electron /xkit /test and GETs to / /test'");
})
