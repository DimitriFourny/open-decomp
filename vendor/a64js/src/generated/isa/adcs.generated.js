export const ENCODINGS = [
    {
        "instructionId": "ADCS",
        "encodingId": "ADCS_32_addsub_carry",
        "mnemonic": "ADCS",
        "className": "Setting the condition flags",
        "fileName": "adcs.xml",
        "mask": 4292934656,
        "value": 973078528,
        "bitCount": 17,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "gp-rd-rn-rm-sf",
        "operandSchemaId": "gp-rd-rn-rm-sf"
    },
    {
        "instructionId": "ADCS",
        "encodingId": "ADCS_64_addsub_carry",
        "mnemonic": "ADCS",
        "className": "Setting the condition flags",
        "fileName": "adcs.xml",
        "mask": 4292934656,
        "value": 3120562176,
        "bitCount": 17,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "gp-rd-rn-rm-sf",
        "operandSchemaId": "gp-rd-rn-rm-sf"
    }
];
