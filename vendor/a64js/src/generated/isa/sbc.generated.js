export const ENCODINGS = [
    {
        "instructionId": "SBC",
        "encodingId": "SBC_32_addsub_carry",
        "mnemonic": "SBC",
        "className": "Not setting the condition flags",
        "fileName": "sbc.xml",
        "mask": 4292934656,
        "value": 1509949440,
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
        "instructionId": "SBC",
        "encodingId": "SBC_64_addsub_carry",
        "mnemonic": "SBC",
        "className": "Not setting the condition flags",
        "fileName": "sbc.xml",
        "mask": 4292934656,
        "value": 3657433088,
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
