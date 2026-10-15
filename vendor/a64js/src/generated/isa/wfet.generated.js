export const ENCODINGS = [
    {
        "instructionId": "WFET",
        "encodingId": "WFET_only_systeminstrswithreg",
        "mnemonic": "WFET",
        "className": "System",
        "fileName": "wfet.xml",
        "mask": 4294967264,
        "value": 3573747712,
        "bitCount": 27,
        "fields": [
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 5,
                "width": 3
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_WFxT"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_WFxT",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "wfxt"
    }
];
